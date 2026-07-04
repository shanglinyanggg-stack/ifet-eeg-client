use crate::models::{DeviceInfo, SampleEvent};
use crate::protocol::parse_packet;
use anyhow::{anyhow, Result};
use btleplug::api::{Central, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};
use chrono::Utc;
use futures::StreamExt;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use uuid::Uuid;

const PPG_SERVICE_UUID: Uuid = Uuid::from_u128(0x0000_fff0_0000_1000_8000_0080_5f9b_34fb);
const PPG_RX_UUID: Uuid = Uuid::from_u128(0x0000_fff5_0000_1000_8000_0080_5f9b_34fb);
const PPG_TX_UUID: Uuid = Uuid::from_u128(0x0000_fff9_0000_1000_8000_0080_5f9b_34fb);

#[derive(Default)]
pub struct BleManagerState {
    inner: Mutex<BleRuntime>,
    recorder: Arc<Mutex<Option<Recorder>>>,
}

#[derive(Default)]
struct BleRuntime {
    adapter: Option<Adapter>,
    peripheral: Option<Peripheral>,
    write_char: Option<Characteristic>,
    notify_task: Option<JoinHandle<()>>,
}

struct Recorder {
    path: PathBuf,
    writer: BufWriter<File>,
}

impl BleManagerState {
    pub async fn scan_devices(&self) -> Result<Vec<DeviceInfo>> {
        let adapter = self.ensure_adapter().await?;
        adapter.start_scan(ScanFilter::default()).await?;
        tokio::time::sleep(Duration::from_secs(3)).await;
        let _ = adapter.stop_scan().await;

        let peripherals = adapter.peripherals().await?;
        let mut devices = Vec::new();
        for peripheral in peripherals {
            let Some(props) = peripheral.properties().await? else {
                continue;
            };
            let name = props.local_name.unwrap_or_else(|| "(未命名设备)".to_string());
            let rssi = props.rssi.unwrap_or(0);
            devices.push(DeviceInfo {
                id: peripheral.id().to_string(),
                name,
                rssi,
            });
        }
        devices.sort_by(|a, b| b.rssi.cmp(&a.rssi));
        Ok(devices)
    }

    pub async fn connect_device(&self, app: AppHandle, device_id: String) -> Result<()> {
        self.disconnect_device().await.ok();

        let adapter = self.ensure_adapter().await?;
        let peripheral = self.find_peripheral(&adapter, &device_id).await?;
        peripheral.connect().await?;
        peripheral.discover_services().await?;

        let chars = peripheral.characteristics();
        let write_char = chars
            .iter()
            .find(|ch| ch.service_uuid == PPG_SERVICE_UUID && ch.uuid == PPG_RX_UUID)
            .cloned()
            .ok_or_else(|| anyhow!("设备缺少写入特征 0xFFF5"))?;
        let notify_char = chars
            .iter()
            .find(|ch| ch.service_uuid == PPG_SERVICE_UUID && ch.uuid == PPG_TX_UUID)
            .cloned()
            .ok_or_else(|| anyhow!("设备缺少通知特征 0xFFF9"))?;

        peripheral.subscribe(&notify_char).await?;
        let mut notifications = peripheral.notifications().await?;
        let recorder = Arc::clone(&self.recorder);
        let task_app = app.clone();
        let notify_task = tokio::spawn(async move {
            while let Some(notification) = notifications.next().await {
                if notification.uuid != PPG_TX_UUID {
                    continue;
                }
                if let Some(packet) = parse_packet(&notification.value) {
                    let timestamp = Utc::now().to_rfc3339();
                    let event = SampleEvent {
                        timestamp: timestamp.clone(),
                        packet: packet.clone(),
                    };
                    let _ = task_app.emit("ble://sample", &event);
                    if let Err(error) = write_record(&recorder, &timestamp, &packet).await {
                        let _ = task_app.emit(
                            "ble://status",
                            crate::models::StatusEvent {
                                message: format!("记录写入失败: {error}"),
                                connected: true,
                            },
                        );
                    }
                }
            }
        });

        {
            let mut inner = self.inner.lock().await;
            inner.peripheral = Some(peripheral);
            inner.write_char = Some(write_char);
            inner.notify_task = Some(notify_task);
        }

        app.emit(
            "ble://status",
            crate::models::StatusEvent {
                message: "BLE 设备已连接".to_string(),
                connected: true,
            },
        )?;
        Ok(())
    }

    pub async fn disconnect_device(&self) -> Result<()> {
        let (peripheral, task) = {
            let mut inner = self.inner.lock().await;
            (inner.peripheral.take(), inner.notify_task.take())
        };

        if let Some(task) = task {
            task.abort();
        }
        if let Some(peripheral) = peripheral {
            if peripheral.is_connected().await.unwrap_or(false) {
                let _ = peripheral.disconnect().await;
            }
        }

        let mut inner = self.inner.lock().await;
        inner.write_char = None;
        Ok(())
    }

    pub async fn send_command(&self, hex: String) -> Result<()> {
        let bytes = parse_hex(&hex)?;
        let (peripheral, write_char) = {
            let inner = self.inner.lock().await;
            (
                inner.peripheral.clone().ok_or_else(|| anyhow!("尚未连接设备"))?,
                inner.write_char.clone().ok_or_else(|| anyhow!("设备缺少写入特征"))?,
            )
        };
        peripheral.write(&write_char, &bytes, WriteType::WithoutResponse).await?;
        Ok(())
    }

    pub async fn start_recording(&self, directory: Option<String>) -> Result<String> {
        let dir = directory
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?.join("recordings"));
        fs::create_dir_all(&dir)?;

        let filename = format!("ppg_eeg_log_{}.csv", Utc::now().format("%Y%m%d_%H%M%S"));
        let path = dir.join(filename);
        let file = File::create(&path)?;
        let mut writer = BufWriter::new(file);
        writeln!(
            writer,
            "time,seq,ir1,red1,green1,ir2,red2,green2,accX,accY,accZ,eeg1,eeg2,eeg3,eeg4,flag"
        )?;
        writer.flush()?;

        let mut recorder = self.recorder.lock().await;
        *recorder = Some(Recorder {
            path: path.clone(),
            writer,
        });
        Ok(path.to_string_lossy().to_string())
    }

    pub async fn stop_recording(&self) -> Result<()> {
        let mut recorder = self.recorder.lock().await;
        if let Some(recording) = recorder.as_mut() {
            recording.writer.flush()?;
        }
        *recorder = None;
        Ok(())
    }

    async fn ensure_adapter(&self) -> Result<Adapter> {
        if let Some(adapter) = self.inner.lock().await.adapter.clone() {
            return Ok(adapter);
        }

        let manager = Manager::new().await?;
        let adapter = manager
            .adapters()
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("未找到蓝牙适配器"))?;

        let mut inner = self.inner.lock().await;
        inner.adapter = Some(adapter.clone());
        Ok(adapter)
    }

    async fn find_peripheral(&self, adapter: &Adapter, device_id: &str) -> Result<Peripheral> {
        let peripherals = adapter.peripherals().await?;
        if let Some(peripheral) = peripherals
            .into_iter()
            .find(|peripheral| peripheral.id().to_string() == device_id)
        {
            return Ok(peripheral);
        }

        adapter.start_scan(ScanFilter::default()).await?;
        tokio::time::sleep(Duration::from_secs(2)).await;
        let _ = adapter.stop_scan().await;
        adapter
            .peripherals()
            .await?
            .into_iter()
            .find(|peripheral| peripheral.id().to_string() == device_id)
            .ok_or_else(|| anyhow!("未找到目标设备: {device_id}"))
    }
}

fn parse_hex(raw: &str) -> Result<Vec<u8>> {
    let normalized = raw
        .chars()
        .map(|ch| if ch.is_ascii_hexdigit() { ch } else { ' ' })
        .collect::<String>();
    let mut bytes = Vec::new();
    for part in normalized.split_whitespace() {
        let value = u8::from_str_radix(part, 16).map_err(|_| anyhow!("命令包含非法十六进制字节"))?;
        bytes.push(value);
    }
    if bytes.is_empty() {
        return Err(anyhow!("命令不能为空"));
    }
    Ok(bytes)
}

async fn write_record(
    recorder: &Arc<Mutex<Option<Recorder>>>,
    timestamp: &str,
    packet: &crate::models::DecodedPacket,
) -> Result<()> {
    let mut recorder = recorder.lock().await;
    let Some(recording) = recorder.as_mut() else {
        return Ok(());
    };

    let eeg = packet.eeg.as_ref();
    writeln!(
        recording.writer,
        "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
        timestamp,
        packet.sequence.map(|value| value.to_string()).unwrap_or_default(),
        packet.ppg.ir1,
        packet.ppg.red1,
        packet.ppg.green1,
        packet.ppg.ir2,
        packet.ppg.red2,
        packet.ppg.green2,
        packet.ppg.acc_x,
        packet.ppg.acc_y,
        packet.ppg.acc_z,
        eeg.map(|value| value.eeg1.to_string()).unwrap_or_default(),
        eeg.map(|value| value.eeg2.to_string()).unwrap_or_default(),
        eeg.map(|value| value.eeg3.to_string()).unwrap_or_default(),
        eeg.map(|value| value.eeg4.to_string()).unwrap_or_default(),
        eeg.and_then(|value| value.flag).map(|value| value.to_string()).unwrap_or_default()
    )?;
    recording.writer.flush()?;
    let _ = &recording.path;
    Ok(())
}
