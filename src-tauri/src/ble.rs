use crate::models::{DeviceInfo, SampleEvent};
use crate::protocol::PacketStreamDecoder;
use anyhow::{anyhow, Result};
use btleplug::api::{
    Central, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use chrono::{Duration as ChronoDuration, Utc};
use futures::StreamExt;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
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
    writer: BufWriter<File>,
    last_flush: Instant,
}

const FLUSH_INTERVAL: Duration = Duration::from_millis(500);

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
            let name = props
                .local_name
                .unwrap_or_else(|| "(未命名设备)".to_string());
            // 0 dBm 会被误认为信号极强，未上报时用 i16::MIN 占位
            let rssi = props.rssi.unwrap_or(i16::MIN);
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
        if let Err(error) = self.disconnect_device().await {
            // 旧连接清理失败不阻断新连接，但要让用户看到
            let _ = app.emit(
                "ble://status",
                crate::models::StatusEvent {
                    message: format!("断开旧设备时出错，已忽略: {error}"),
                    connected: false,
                },
            );
        }

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
            let mut decoder = PacketStreamDecoder::default();
            let mut next_sample_timestamp: Option<chrono::DateTime<Utc>> = None;
            while let Some(notification) = notifications.next().await {
                if notification.uuid != PPG_TX_UUID {
                    continue;
                }
                let rows = decoder.push(&notification.value);
                if rows.is_empty() {
                    continue;
                }
                let now = Utc::now();
                if next_sample_timestamp.as_ref().is_some_and(|next| {
                    now.signed_duration_since(next.clone()).num_milliseconds() > 2_000
                }) {
                    next_sample_timestamp = Some(now);
                }
                for row in rows {
                    let sample_timestamp = next_sample_timestamp.clone().unwrap_or(now);
                    next_sample_timestamp =
                        Some(sample_timestamp + ChronoDuration::milliseconds(10));
                    let timestamp = sample_timestamp.to_rfc3339();
                    let event = SampleEvent {
                        timestamp: timestamp.clone(),
                        valid: row.valid,
                        device_sequence: row.device_sequence,
                        packet: row.packet.clone(),
                    };
                    let _ = task_app.emit("ble://sample", &event);
                    if let Err(error) = write_record(
                        &recorder,
                        &timestamp,
                        row.valid,
                        row.device_sequence,
                        &row.packet,
                    )
                    .await
                    {
                        let _ = task_app.emit(
                            "ble://status",
                            crate::models::StatusEvent {
                                message: format!("记录写入失败，已停止录制: {error}"),
                                connected: true,
                            },
                        );
                        // 写盘失败后主动停止录制，避免后续样本继续往坏掉的 writer 写
                        abort_recorder(&recorder).await;
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
                inner
                    .peripheral
                    .clone()
                    .ok_or_else(|| anyhow!("尚未连接设备"))?,
                inner
                    .write_char
                    .clone()
                    .ok_or_else(|| anyhow!("设备缺少写入特征"))?,
            )
        };
        peripheral
            .write(&write_char, &bytes, WriteType::WithoutResponse)
            .await?;
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
            "time,seq,ir1,red1,green1,ir2,red2,green2,accX,accY,accZ,eeg1,eeg2,eeg3,eeg4,flag,valid,deviceSeq"
        )?;
        writer.flush()?;

        let mut recorder = self.recorder.lock().await;
        *recorder = Some(Recorder {
            writer,
            last_flush: Instant::now(),
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
        if let Some(peripheral) = adapter
            .peripherals()
            .await?
            .into_iter()
            .find(|peripheral| peripheral.id().to_string() == device_id)
        {
            return Ok(peripheral);
        }

        // 兜底：扫描期间轮询 peripherals()，命中即返回，避免固定 sleep 拖慢连接
        adapter.start_scan(ScanFilter::default()).await?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(peripheral) = adapter
                .peripherals()
                .await?
                .into_iter()
                .find(|peripheral| peripheral.id().to_string() == device_id)
            {
                let _ = adapter.stop_scan().await;
                return Ok(peripheral);
            }
            if Instant::now() >= deadline {
                let _ = adapter.stop_scan().await;
                return Err(anyhow!("未找到目标设备: {device_id}"));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

fn parse_hex(raw: &str) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    for part in raw.split(|ch: char| !ch.is_ascii_hexdigit()) {
        if part.is_empty() {
            continue;
        }
        let value =
            u8::from_str_radix(part, 16).map_err(|_| anyhow!("命令包含非法十六进制字节"))?;
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
    valid: bool,
    device_sequence: Option<u8>,
    packet: &crate::models::DecodedPacket,
) -> Result<()> {
    let mut recorder = recorder.lock().await;
    let Some(recording) = recorder.as_mut() else {
        return Ok(());
    };

    let eeg = packet.eeg.as_ref();
    writeln!(
        recording.writer,
        "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
        timestamp,
        packet
            .sequence
            .map(|value| value.to_string())
            .unwrap_or_default(),
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
        eeg.and_then(|value| value.flag)
            .map(|value| value.to_string())
            .unwrap_or_default(),
        valid,
        device_sequence
            .map(|value| value.to_string())
            .unwrap_or_default()
    )?;
    // 定时 flush，避免每个样本都触发系统调用拖垮采集线程
    if recording.last_flush.elapsed() >= FLUSH_INTERVAL {
        recording.writer.flush()?;
        recording.last_flush = Instant::now();
    }
    Ok(())
}

async fn abort_recorder(recorder: &Arc<Mutex<Option<Recorder>>>) {
    let mut recorder = recorder.lock().await;
    if let Some(recording) = recorder.as_mut() {
        let _ = recording.writer.flush();
    }
    *recorder = None;
}
