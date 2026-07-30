use crate::battery::BatteryEstimator;
use crate::models::{BatteryEvent, DeviceInfo, SampleEvent};
use crate::protocol::{
    parse_battery_frame, sample_interval_nanoseconds, sample_rate_command,
    samples_per_notification, PacketStreamDecoder, DEFAULT_SAMPLE_RATE_HZ,
};
use anyhow::{anyhow, Result};
use btleplug::api::{
    Central, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use chrono::{DateTime, Duration as ChronoDuration, Local, SecondsFormat, Utc};
use futures::StreamExt;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use uuid::Uuid;

const PPG_SERVICE_UUID: Uuid = Uuid::from_u128(0x0000_fff0_0000_1000_8000_0080_5f9b_34fb);
const PPG_RX_UUID: Uuid = Uuid::from_u128(0x0000_fff5_0000_1000_8000_0080_5f9b_34fb);
const PPG_TX_UUID: Uuid = Uuid::from_u128(0x0000_fff9_0000_1000_8000_0080_5f9b_34fb);

pub struct BleManagerState {
    inner: Mutex<BleRuntime>,
    recorder: Arc<Mutex<Option<Recorder>>>,
    battery_recorder: Arc<Mutex<Option<BatteryRecorder>>>,
    sample_rate_hz: Arc<AtomicU32>,
}

impl Default for BleManagerState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(BleRuntime::default()),
            recorder: Arc::new(Mutex::new(None)),
            battery_recorder: Arc::new(Mutex::new(None)),
            sample_rate_hz: Arc::new(AtomicU32::new(DEFAULT_SAMPLE_RATE_HZ)),
        }
    }
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
    marker_writer: BufWriter<File>,
    marker_path: PathBuf,
    last_flush: Instant,
}

struct BatteryRecorder {
    writer: BufWriter<File>,
}

const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
const FRONTEND_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const MAX_FRONTEND_BATCH_SAMPLES: usize = 512;
// 设备协议没有硬件绝对时间。逻辑采样时钟与主机到达时间偏差过大时，
// 重新锚定到本次 BLE 通知，避免长时间记录逐步偏离 PSG 的墙钟时间。
const SAMPLE_CLOCK_REANCHOR_THRESHOLD_MS: i64 = 250;

impl BleManagerState {
    pub async fn scan_devices(&self) -> Result<Vec<DeviceInfo>> {
        let adapter = self.ensure_adapter().await?;
        adapter.start_scan(ScanFilter::default()).await?;
        tokio::time::sleep(Duration::from_secs(3)).await;
        let _ = adapter.stop_scan().await;

        let peripherals = adapter.peripherals().await?;
        let mut devices = Vec::new();
        for peripheral in peripherals {
            let props = match peripheral.properties().await {
                Ok(Some(props)) => props,
                // 系统缓存中偶尔会残留已离线外设，不能让单个读取错误终止持续扫描。
                Ok(None) | Err(_) => continue,
            };
            let Some(name) = props.local_name else {
                continue;
            };
            if !is_td_device_name(&name) {
                continue;
            }
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
        let setup = async {
            tokio::time::timeout(Duration::from_secs(12), peripheral.connect())
                .await
                .map_err(|_| anyhow!("连接设备超时"))??;
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
            let notifications = peripheral.notifications().await?;
            Ok::<_, anyhow::Error>((write_char, notifications))
        }
        .await;

        let (write_char, mut notifications) = match setup {
            Ok(value) => value,
            Err(error) => {
                // 持续扫描会反复尝试候选设备，失败时必须释放半连接状态。
                if peripheral.is_connected().await.unwrap_or(false) {
                    let _ = peripheral.disconnect().await;
                }
                return Err(error);
            }
        };
        let recorder = Arc::clone(&self.recorder);
        let battery_recorder = Arc::clone(&self.battery_recorder);
        let selected_sample_rate = Arc::clone(&self.sample_rate_hz);
        let task_app = app.clone();
        let notify_task = tokio::spawn(async move {
            let mut active_sample_rate = selected_sample_rate.load(Ordering::Relaxed);
            let mut decoder = PacketStreamDecoder::new(active_sample_rate);
            let mut next_sample_timestamp: Option<chrono::DateTime<Utc>> = None;
            let mut pending_frontend_samples = Vec::<SampleEvent>::with_capacity(128);
            let mut battery_estimator = BatteryEstimator::default();
            let mut last_frontend_emit = Instant::now();
            while let Some(notification) = notifications.next().await {
                if notification.uuid != PPG_TX_UUID {
                    continue;
                }
                if let Some(battery) = parse_battery_frame(&notification.value) {
                    let estimate = battery_estimator.update(battery.voltage, battery.charging);
                    let battery_event = BatteryEvent {
                        timestamp: local_now_rfc3339(),
                        sequence: battery.sequence,
                        charging: battery.charging,
                        raw_value: battery.raw_value,
                        voltage: battery.voltage,
                        smoothed_voltage: estimate.smoothed_voltage,
                        estimated_percent: estimate.estimated_percent,
                        level: estimate.level,
                    };
                    if let Err(error) =
                        write_battery_record(&battery_recorder, &battery_event).await
                    {
                        let _ = task_app.emit(
                            "ble://status",
                            crate::models::StatusEvent {
                                message: format!("电压记录写入失败，已停止电压记录: {error}"),
                                connected: true,
                            },
                        );
                        abort_battery_recorder(&battery_recorder).await;
                        let _ = task_app.emit("ble://battery-recording", false);
                    }
                    let _ = task_app.emit("ble://battery", battery_event);
                    continue;
                }
                let requested_sample_rate = selected_sample_rate.load(Ordering::Relaxed);
                if requested_sample_rate != active_sample_rate {
                    active_sample_rate = requested_sample_rate;
                    decoder.set_sample_rate(active_sample_rate);
                    next_sample_timestamp = None;
                }
                let rows = decoder.push(&notification.value);
                if rows.is_empty() {
                    continue;
                }
                let now = Utc::now();
                // 一包多数据代表到达通知之前的一段采样；让最后一个样本落在
                // 主机实际接收时刻，避免把整包样本写到未来。
                let interval_ns = sample_interval_nanoseconds(active_sample_rate);
                let packet_start =
                    arrival_aligned_packet_start(now, rows.len(), active_sample_rate);
                let should_reanchor = match next_sample_timestamp.as_ref() {
                    Some(next) => {
                        packet_start
                            .signed_duration_since(next.clone())
                            .num_milliseconds()
                            .abs()
                            > SAMPLE_CLOCK_REANCHOR_THRESHOLD_MS
                    }
                    None => true,
                };
                if should_reanchor {
                    next_sample_timestamp = Some(packet_start);
                }
                let mut sample_events = Vec::with_capacity(rows.len());
                for row in rows {
                    let sample_timestamp = next_sample_timestamp.clone().unwrap_or(now);
                    next_sample_timestamp =
                        Some(sample_timestamp + ChronoDuration::nanoseconds(interval_ns));
                    let timestamp = local_rfc3339(sample_timestamp);
                    let event = SampleEvent {
                        timestamp: timestamp.clone(),
                        sample_rate_hz: active_sample_rate,
                        valid: row.valid,
                        device_sequence: row.device_sequence,
                        packet: row.packet.clone(),
                    };
                    sample_events.push(event);
                }

                // 一次锁定写完整包；记录成功（或当前未记录）后，才把数据交给
                // UI 实时链路。这样记录数据不会因前端清理或过载而丢失。
                if let Err(error) = write_records(&recorder, &sample_events).await {
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

                pending_frontend_samples.extend(sample_events);
                if pending_frontend_samples.len() >= MAX_FRONTEND_BATCH_SAMPLES
                    || last_frontend_emit.elapsed() >= FRONTEND_EMIT_INTERVAL
                {
                    let batch = std::mem::take(&mut pending_frontend_samples);
                    let _ = task_app.emit("ble://samples", &batch);
                    // emit 序列化完成后 batch 离开作用域，立即释放本批原始样本。
                    last_frontend_emit = Instant::now();
                }
            }
            if !pending_frontend_samples.is_empty() {
                let _ = task_app.emit("ble://samples", &pending_frontend_samples);
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
        self.write_bytes(&bytes).await
    }

    pub async fn set_sample_rate(&self, sample_rate_hz: u32) -> Result<()> {
        let command = sample_rate_command(sample_rate_hz)
            .ok_or_else(|| anyhow!("不支持的采样率 {sample_rate_hz} Hz"))?;
        debug_assert!(samples_per_notification(sample_rate_hz).is_some());
        self.write_bytes(&command).await?;
        self.sample_rate_hz.store(sample_rate_hz, Ordering::Relaxed);
        Ok(())
    }

    async fn write_bytes(&self, bytes: &[u8]) -> Result<()> {
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
            .write(&write_char, bytes, WriteType::WithoutResponse)
            .await?;
        Ok(())
    }

    pub async fn start_recording(&self, directory: Option<String>) -> Result<String> {
        let dir = directory
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?.join("recordings"));
        fs::create_dir_all(&dir)?;

        let filename = format!("ppg_eeg_log_{}.csv", Local::now().format("%Y%m%d_%H%M%S"));
        let path = dir.join(filename);
        let file = File::create(&path)?;
        let mut writer = BufWriter::new(file);
        writeln!(
            writer,
            "time,sampleRateHz,seq,ir1,red1,green1,ir2,red2,green2,accX,accY,accZ,eeg1,eeg2,eeg3,eeg4,flag,valid,deviceSeq"
        )?;
        writer.flush()?;

        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("ppg_eeg_log");
        let marker_path = path.with_file_name(format!("{stem}_markers.csv"));
        let marker_file = File::create(&marker_path)?;
        let mut marker_writer = BufWriter::new(marker_file);
        writeln!(
            marker_writer,
            "time,participantId,label,note,sampleCount,deviceFlag,algorithmAction,eeg1,eeg2,eeg3,eeg4"
        )?;
        marker_writer.flush()?;

        let mut recorder = self.recorder.lock().await;
        *recorder = Some(Recorder {
            writer,
            marker_writer,
            marker_path,
            last_flush: Instant::now(),
        });
        Ok(path.to_string_lossy().to_string())
    }

    pub async fn stop_recording(&self) -> Result<()> {
        let mut recorder = self.recorder.lock().await;
        if let Some(recording) = recorder.as_mut() {
            recording.writer.flush()?;
            recording.marker_writer.flush()?;
        }
        *recorder = None;
        Ok(())
    }

    pub async fn start_battery_recording(&self, directory: Option<String>) -> Result<String> {
        let dir = directory
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?.join("recordings"));
        fs::create_dir_all(&dir)?;

        let mut recorder = self.battery_recorder.lock().await;
        if recorder.is_some() {
            return Err(anyhow!("电压记录已开启"));
        }

        let filename = format!(
            "battery_voltage_log_{}.csv",
            Local::now().format("%Y%m%d_%H%M%S_%3f")
        );
        let path = dir.join(filename);
        let file = File::create(&path)?;
        let mut writer = BufWriter::new(file);
        writeln!(
            writer,
            "time,sequence,rawValue,voltage,smoothedVoltage,estimatedPercent,charging,level"
        )?;
        writer.flush()?;

        *recorder = Some(BatteryRecorder { writer });
        Ok(path.to_string_lossy().to_string())
    }

    pub async fn stop_battery_recording(&self) -> Result<()> {
        let mut recorder = self.battery_recorder.lock().await;
        if let Some(recording) = recorder.as_mut() {
            recording.writer.flush()?;
        }
        *recorder = None;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn append_debug_marker(
        &self,
        participant_id: String,
        label: String,
        note: String,
        sample_count: u64,
        device_flag: Option<u8>,
        algorithm_action: String,
        eeg1: Option<f64>,
        eeg2: Option<f64>,
        eeg3: Option<f64>,
        eeg4: Option<f64>,
    ) -> Result<String> {
        let mut recorder = self.recorder.lock().await;
        let recording = recorder
            .as_mut()
            .ok_or_else(|| anyhow!("请先开始记录，再添加调试标记"))?;
        writeln!(
            recording.marker_writer,
            "{},{},{},{},{},{},{},{},{},{},{}",
            local_now_rfc3339(),
            csv_field(&participant_id),
            csv_field(&label),
            csv_field(&note),
            sample_count,
            device_flag
                .map(|value| value.to_string())
                .unwrap_or_default(),
            csv_field(&algorithm_action),
            optional_number(eeg1),
            optional_number(eeg2),
            optional_number(eeg3),
            optional_number(eeg4),
        )?;
        recording.marker_writer.flush()?;
        Ok(recording.marker_path.to_string_lossy().to_string())
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

fn is_td_device_name(name: &str) -> bool {
    name.trim_start()
        .get(..2)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("TD"))
}

fn parse_hex(raw: &str) -> Result<Vec<u8>> {
    let compact = raw.trim();
    if !compact.is_empty() && compact.chars().all(|ch| ch.is_ascii_hexdigit()) {
        if compact.len() % 2 != 0 {
            return Err(anyhow!("紧凑十六进制命令必须包含偶数字符"));
        }
        return compact
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                std::str::from_utf8(pair)
                    .ok()
                    .and_then(|value| u8::from_str_radix(value, 16).ok())
                    .ok_or_else(|| anyhow!("命令包含非法十六进制字节"))
            })
            .collect();
    }
    let normalized = raw.replace("0x", "").replace("0X", "");
    let mut bytes = Vec::new();
    for part in normalized.split(|ch: char| !ch.is_ascii_hexdigit()) {
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

async fn write_records(
    recorder: &Arc<Mutex<Option<Recorder>>>,
    events: &[SampleEvent],
) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let mut recorder = recorder.lock().await;
    let Some(recording) = recorder.as_mut() else {
        return Ok(());
    };

    write_record_rows(&mut recording.writer, events)?;
    // 定时 flush，避免每个样本都触发系统调用拖垮采集线程
    if recording.last_flush.elapsed() >= FLUSH_INTERVAL {
        recording.writer.flush()?;
        recording.marker_writer.flush()?;
        recording.last_flush = Instant::now();
    }
    Ok(())
}

fn write_record_rows(writer: &mut impl Write, events: &[SampleEvent]) -> Result<()> {
    for event in events {
        let packet = &event.packet;
        let eeg = packet.eeg.as_ref();
        writeln!(
            writer,
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
            event.timestamp,
            event.sample_rate_hz,
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
            event.valid,
            event
                .device_sequence
                .map(|value| value.to_string())
                .unwrap_or_default()
        )?;
    }
    Ok(())
}

async fn write_battery_record(
    recorder: &Arc<Mutex<Option<BatteryRecorder>>>,
    battery: &BatteryEvent,
) -> Result<()> {
    let mut recorder = recorder.lock().await;
    let Some(recording) = recorder.as_mut() else {
        return Ok(());
    };
    write_battery_row(&mut recording.writer, battery)?;
    // 电压帧频率远低于 EEG；逐帧 flush 可保证意外断电前的电量轨迹落盘。
    recording.writer.flush()?;
    Ok(())
}

fn write_battery_row(writer: &mut impl Write, battery: &BatteryEvent) -> Result<()> {
    writeln!(
        writer,
        "{},{},{},{:.6},{:.6},{},{},{}",
        battery.timestamp,
        battery.sequence,
        battery.raw_value,
        battery.voltage,
        battery.smoothed_voltage,
        battery.estimated_percent,
        battery.charging,
        battery.level.as_str()
    )?;
    Ok(())
}

async fn abort_recorder(recorder: &Arc<Mutex<Option<Recorder>>>) {
    let mut recorder = recorder.lock().await;
    if let Some(recording) = recorder.as_mut() {
        let _ = recording.writer.flush();
        let _ = recording.marker_writer.flush();
    }
    *recorder = None;
}

async fn abort_battery_recorder(recorder: &Arc<Mutex<Option<BatteryRecorder>>>) {
    let mut recorder = recorder.lock().await;
    if let Some(recording) = recorder.as_mut() {
        let _ = recording.writer.flush();
    }
    *recorder = None;
}

fn csv_field(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('"', "\"\"")
            .replace('\r', " ")
            .replace('\n', " ")
    )
}

fn optional_number(value: Option<f64>) -> String {
    value
        .filter(|number| number.is_finite())
        .map(|number| number.to_string())
        .unwrap_or_default()
}

fn local_now_rfc3339() -> String {
    local_rfc3339(Utc::now())
}

fn local_rfc3339(timestamp: DateTime<Utc>) -> String {
    timestamp
        .with_timezone(&Local)
        .to_rfc3339_opts(SecondsFormat::Micros, true)
}

fn arrival_aligned_packet_start(
    arrival: DateTime<Utc>,
    sample_count: usize,
    sample_rate_hz: u32,
) -> DateTime<Utc> {
    arrival
        - ChronoDuration::nanoseconds(
            sample_interval_nanoseconds(sample_rate_hz) * sample_count.saturating_sub(1) as i64,
        )
}

#[cfg(test)]
mod tests {
    use super::{
        arrival_aligned_packet_start, is_td_device_name, local_rfc3339, parse_hex,
        write_battery_row, write_record_rows, BleManagerState,
    };
    use crate::battery::BatteryLevel;
    use crate::models::{BatteryEvent, DecodedPacket, EegSample, PpgSample, SampleEvent};
    use chrono::{DateTime, Duration as ChronoDuration, Local, TimeZone, Utc};
    use uuid::Uuid;

    #[test]
    fn accepts_compact_and_spaced_sample_rate_commands() {
        assert_eq!(parse_hex("7201").unwrap(), vec![0x72, 0x01]);
        assert_eq!(parse_hex("72 04").unwrap(), vec![0x72, 0x04]);
        assert_eq!(parse_hex("0x72, 0x03").unwrap(), vec![0x72, 0x03]);
        assert!(parse_hex("721").is_err());
    }

    #[test]
    fn filters_scanned_devices_to_td_prefix() {
        assert!(is_td_device_name("TD10"));
        assert!(is_td_device_name("  td-headset"));
        assert!(!is_td_device_name("iFET TD10"));
        assert!(!is_td_device_name("EEG Headset"));
        assert!(!is_td_device_name(""));
    }

    #[test]
    fn local_timestamp_preserves_real_instant_and_explicit_offset() {
        let utc = Utc.with_ymd_and_hms(2026, 7, 22, 8, 8, 24).unwrap();
        let formatted = local_rfc3339(utc);
        let parsed = DateTime::parse_from_rfc3339(&formatted).unwrap();
        assert_eq!(parsed.with_timezone(&Utc), utc);
        assert_eq!(
            parsed.offset().local_minus_utc(),
            utc.with_timezone(&Local).offset().local_minus_utc()
        );
    }

    #[test]
    fn multi_sample_packet_ends_at_real_host_arrival_time() {
        let arrival = Utc.with_ymd_and_hms(2026, 7, 22, 8, 8, 24).unwrap();
        let start = arrival_aligned_packet_start(arrival, 8, 1_000);
        assert_eq!(start, arrival - ChronoDuration::milliseconds(7));
        assert_eq!(start + ChronoDuration::milliseconds(7), arrival);
    }

    #[test]
    fn writes_every_sample_in_a_recording_batch_before_release() {
        let event = |sequence: u8| SampleEvent {
            timestamp: format!("2026-07-22T17:00:00.{sequence:06}+08:00"),
            sample_rate_hz: 1_000,
            valid: true,
            device_sequence: Some(sequence),
            packet: DecodedPacket {
                sequence: Some(sequence),
                ppg: PpgSample {
                    ir1: 1,
                    red1: 2,
                    green1: 3,
                    ir2: 4,
                    red2: 5,
                    green2: 6,
                    acc_x: 7,
                    acc_y: 8,
                    acc_z: 9,
                },
                eeg: Some(EegSample {
                    eeg1: 10,
                    eeg2: 11,
                    eeg3: 12,
                    eeg4: 13,
                    flag: Some(14),
                }),
            },
        };
        let mut csv = Vec::new();
        write_record_rows(&mut csv, &[event(1), event(2)]).unwrap();
        let text = String::from_utf8(csv).unwrap();
        let rows: Vec<&str> = text.lines().collect();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].contains(",1000,1,"));
        assert!(rows[1].contains(",1000,2,"));
    }

    #[test]
    fn writes_raw_and_calibrated_battery_values_to_the_auxiliary_log() {
        let mut csv = Vec::new();
        write_battery_row(
            &mut csv,
            &BatteryEvent {
                timestamp: "2026-07-23T01:02:03.000000+08:00".to_string(),
                sequence: 9,
                charging: false,
                raw_value: 444,
                voltage: 444.0 / 135.0,
                smoothed_voltage: 3.29,
                estimated_percent: 0,
                level: BatteryLevel::Empty,
            },
        )
        .unwrap();
        let csv = String::from_utf8(csv).unwrap();
        assert!(csv.contains(",9,444,3.288889,3.290000,0,false,empty"));
    }

    #[tokio::test]
    async fn battery_recording_has_an_independent_file_and_lifecycle() {
        let directory =
            std::env::temp_dir().join(format!("ifet-eeg-battery-recording-{}", Uuid::new_v4()));
        let state = BleManagerState::default();
        let path = state
            .start_battery_recording(Some(directory.to_string_lossy().to_string()))
            .await
            .unwrap();
        assert!(path.contains("battery_voltage_log_"));
        assert!(!path.contains("ppg_eeg_log_"));

        let duplicate = state
            .start_battery_recording(Some(directory.to_string_lossy().to_string()))
            .await
            .unwrap_err();
        assert!(duplicate.to_string().contains("电压记录已开启"));

        state.stop_battery_recording().await.unwrap();
        let csv = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            csv.trim(),
            "time,sequence,rawValue,voltage,smoothedVoltage,estimatedPercent,charging,level"
        );

        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }
}
