use crate::battery::BatteryEstimator;
use crate::lsl::LslPublisher;
use crate::models::{BatteryEvent, DeviceInfo, SampleEvent};
use crate::protocol::{
    parse_battery_frame, sample_interval_nanoseconds, sample_rate_command,
    samples_per_notification, documented_rate_commands, inspect_td_payload, TdPayloadIntegrity,
    PacketStreamDecoder, DEFAULT_SAMPLE_RATE_HZ,
};
use anyhow::{anyhow, Result};
use btleplug::api::{
    Central, Characteristic, CharPropFlags, Manager as _, Peripheral as _, ScanFilter, WriteType,ValueNotification,RetrievePeripheralsOptions,
};
use btleplug::platform::{Adapter, Manager, Peripheral, PeripheralId};
use chrono::{DateTime, Duration as ChronoDuration, Local, SecondsFormat, Utc};
use futures::{Stream,StreamExt};
use std::pin::Pin;
use std::fs::{self, File};
use std::collections::{VecDeque,BTreeMap};
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
const START_STREAM_COMMAND: [u8; 4] = [0xaa, 0x55, 0x01, 0x01];
const NO_DATA_DIAGNOSTIC_BATTERY_FRAMES: usize = 3;

pub struct BleManagerState {
    inner: Mutex<BleRuntime>,
    lifecycle_lock: Mutex<()>,
    recorder: Arc<Mutex<Option<Recorder>>>,
    battery_recorder: Arc<Mutex<Option<BatteryRecorder>>>,
    sample_rate_hz: Arc<AtomicU32>,
    transmit_interval_ms: Arc<AtomicU32>,
    command_lock: Arc<Mutex<()>>,
}

impl Default for BleManagerState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(BleRuntime::default()),
            lifecycle_lock: Mutex::new(()),
            recorder: Arc::new(Mutex::new(None)),
            battery_recorder: Arc::new(Mutex::new(None)),
            sample_rate_hz: Arc::new(AtomicU32::new(DEFAULT_SAMPLE_RATE_HZ)),
            transmit_interval_ms: Arc::new(AtomicU32::new(0)),
            command_lock: Arc::new(Mutex::new(())),
        }
    }
}

#[derive(Default)]
struct BleRuntime {
    adapter: Option<Adapter>,
    adapter_init_error: Option<String>,
    known_ids: BTreeMap<String,PeripheralId>,
    peripheral: Option<Peripheral>,
    write_char: Option<Characteristic>,
    notify_task: Option<JoinHandle<()>>,
}

struct Recorder {
    path: PathBuf,
    writer: BufWriter<File>,
    marker_writer: BufWriter<File>,
    marker_path: PathBuf,
    last_flush: Instant,
    sample_count: u64,
    sample_index: VecDeque<(f64, u64)>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct StimulusAlignment {
    pub nearest_received_sample_index: Option<u64>,
    pub nearest_received_sample_time_unix_s: Option<f64>,
    pub alignment_error_ms: Option<f64>,
}

struct BatteryRecorder {
    writer: BufWriter<File>,
}

const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
const FRONTEND_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const MAX_FRONTEND_BATCH_SAMPLES: usize = 512;
const NOTIFICATION_QUEUE_CAPACITY:usize=2048;
struct BufferedNotifications {
    receiver:tokio::sync::mpsc::Receiver<(ValueNotification,DateTime<Utc>,Instant)>,
    producer:JoinHandle<()>,
}
impl Drop for BufferedNotifications {fn drop(&mut self){self.producer.abort();}}
fn buffer_notifications(mut source:Pin<Box<dyn Stream<Item=ValueNotification>+Send>>) -> BufferedNotifications {
    let (sender,receiver)=tokio::sync::mpsc::channel(NOTIFICATION_QUEUE_CAPACITY);
    let producer=tokio::spawn(async move {
        while let Some(notification)=source.next().await {
            // Capture arrival before disk/UI work. This queue does not actively
            // discard entries: after 2048 notifications, it applies backpressure.
            // The upstream btleplug broadcast can still lag and lose entries;
            // this buffer alone cannot guarantee lossless CoreBluetooth delivery.
            if sender.send((notification,Utc::now(),Instant::now())).await.is_err(){break;}
        }
    });
    BufferedNotifications{receiver,producer}
}
// 设备协议没有硬件绝对时间。逻辑采样时钟与主机到达时间偏差过大时，
// 重新锚定到本次 BLE 通知，避免长时间记录逐步偏离 PSG 的墙钟时间。
#[cfg(test)]
const SAMPLE_CLOCK_REANCHOR_THRESHOLD_MS: i64 = 250;

impl BleManagerState {
    pub async fn scan_devices(&self) -> Result<Vec<DeviceInfo>> {
        let _lifecycle = self.lifecycle_lock.lock().await;
        let adapter = self.ensure_adapter().await?;
        bounded_ble_operation("开始蓝牙扫描", Duration::from_secs(3), adapter.start_scan(ScanFilter::default())).await?;
        tokio::time::sleep(Duration::from_secs(3)).await;
        let _ = bounded_ble_operation("停止蓝牙扫描", Duration::from_secs(2), adapter.stop_scan()).await;

        let peripherals = adapter.peripherals().await?;
        let mut devices = Vec::new();
        let mut known_ids = Vec::new();
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
            known_ids.push((peripheral.id().to_string(), peripheral.id()));
            devices.push(DeviceInfo {
                id: peripheral.id().to_string(),
                name,
                rssi,
            });
        }
        {
            let mut inner = self.inner.lock().await;
            for (key, id) in known_ids {
                remember_td_identifier(&mut inner.known_ids, key, id);
            }
        }
        devices.sort_by(|a, b| b.rssi.cmp(&a.rssi));
        Ok(devices)
    }

    pub async fn connect_device(
        &self,
        app: AppHandle,
        device_id: String,
        lsl_publisher: LslPublisher,
        requested_sample_rate:Option<u32>,
    ) -> Result<()> {
        // Serialise the complete connection lifecycle. Concurrent operations
        // used to overwrite CoreBluetooth pending futures and hang indefinitely.
        let _lifecycle=self.lifecycle_lock.lock().await;
        if let Some(rate)=requested_sample_rate {
            if sample_rate_command(rate).is_none(){return Err(anyhow!("不支持的采样率 {rate} Hz"));}
            self.sample_rate_hz.store(rate,Ordering::Relaxed);
        }
        if let Err(error) = self.disconnect_device_inner().await {
            let _ = app.emit(
                "ble://status",
                crate::models::StatusEvent {
                    message: format!("旧连接未能确认释放，已停止新连接: {error}"),
                    connected: false,
                },
            );
            return Err(error);
        }

        let adapter = self.ensure_adapter().await?;
        let peripheral = self.find_peripheral(&adapter, &device_id).await?;
        let setup = async {
            tokio::time::timeout(Duration::from_secs(12), peripheral.connect())
                .await
                .map_err(|_| anyhow!("连接设备超时"))??;
            bounded_ble_operation("蓝牙服务发现",Duration::from_secs(8),peripheral.discover_services()).await?;

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

            // Register and start draining before enabling FFF9 notifications:
            // the device may deliver its first value during subscribe().await.
            let notifications = buffer_notifications(bounded_ble_operation("建立通知接收", Duration::from_secs(3), peripheral.notifications()).await?);
            bounded_ble_operation("启用FFF9通知",Duration::from_secs(5),peripheral.subscribe(&notify_char)).await?;
            // Some TD10 firmware reports battery frames immediately after
            // subscribe but does not start the 0x01 EEG stream until FFF5 is
            // explicitly armed.  Do this before returning "connected", then
            // apply the currently selected multi-sample rate.
            let _commands=self.command_lock.lock().await;
            let rate=self.sample_rate_hz.load(Ordering::Relaxed);
            write_rate_configuration(&peripheral,&write_char,rate).await?;
            self.transmit_interval_ms.store(0,Ordering::Relaxed);
            Ok::<_, anyhow::Error>((write_char, notifications))
        }
        .await;

        let (write_char, mut notifications) = match setup {
            Ok(value) => value,
            Err(error) => {
                // 持续扫描会反复尝试候选设备，失败时必须释放半连接状态。
                if !matches!(bounded_ble_operation("检查半连接", Duration::from_secs(2), peripheral.is_connected()).await, Ok(false)) {
                    if bounded_ble_operation("释放半连接", Duration::from_secs(3), peripheral.disconnect()).await.is_err() {
                        let mut inner = self.inner.lock().await;
                        inner.adapter = None;
                        inner.peripheral = Some(peripheral.clone());
                    }
                }
                return Err(error);
            }
        };
        let recorder = Arc::clone(&self.recorder);
        let battery_recorder = Arc::clone(&self.battery_recorder);
        let selected_sample_rate = Arc::clone(&self.sample_rate_hz);
        let selected_transmit_interval = Arc::clone(&self.transmit_interval_ms);
        let command_lock=Arc::clone(&self.command_lock);
        let task_app = app.clone();
        let recovery_peripheral = peripheral.clone();
        let recovery_write_char = write_char.clone();
        let mut platform_link = configure_platform_link(&peripheral).await;
        let notify_task = tokio::spawn(async move {
            let mut active_sample_rate = selected_sample_rate.load(Ordering::Relaxed);
            let mut decoder = PacketStreamDecoder::new_raw(active_sample_rate).limit_notification_samples(8);
            let mut next_sample_timestamp: Option<chrono::DateTime<Utc>> = None;
            let mut pending_frontend_samples = Vec::<SampleEvent>::with_capacity(128);
            let mut battery_estimator = BatteryEstimator::default();
            let mut last_frontend_emit = Instant::now();
            let mut battery_notifications_before_data = 0usize;
            let mut rejected_notifications_before_data = 0usize;
            let mut data_notifications = 0usize;
            let mut recovery_command_sent = false;
            let mut diagnostic_started=Instant::now();
            let mut diagnostic_origin=Instant::now();
            let mut rate_window=VecDeque::<(Instant,usize,usize,usize,TdPayloadIntegrity,usize)>::new();
            let mut peak_processing_delay_ms=0_i64;
            let mut link_checked = Instant::now();
            while let Some((notification,arrival_time,arrival_instant)) = notifications.receiver.recv().await {
                if notification.uuid != PPG_TX_UUID || notification.service_uuid != PPG_SERVICE_UUID {
                    continue;
                }
                if let Some(battery) = parse_battery_frame(&notification.value) {
                    if data_notifications == 0 {
                        battery_notifications_before_data += 1;
                    }
                    let estimate = battery_estimator.update(battery.voltage, battery.charging);
                    let battery_event = BatteryEvent {
                        timestamp: local_rfc3339(arrival_time),
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
                    if data_notifications == 0
                        && battery_notifications_before_data
                            >= NO_DATA_DIAGNOSTIC_BATTERY_FRAMES
                        && !recovery_command_sent
                    {
                        recovery_command_sent = true;
                        let charging_hint = if battery.charging {
                            "；设备正在充电，固件可能暂停EEG，请拔掉充电线后重连"
                        } else {
                            ""
                        };
                        let _ = task_app.emit(
                            "ble://status",
                            crate::models::StatusEvent {
                                message: format!(
                                    "FFF9仅收到电量包，未收到EEG数据{charging_hint}；正在自动重发启动与采样率命令"
                                ),
                                connected: true,
                            },
                        );
                        let _commands=command_lock.lock().await;
                        let rate=selected_sample_rate.load(Ordering::Relaxed);
                        // Legacy start is a fallback only after confirmed
                        // battery-only reception, never part of normal 72 setup.
                        let _=write_supported_command(&recovery_peripheral,&recovery_write_char,&START_STREAM_COMMAND).await;
                        tokio::time::sleep(Duration::from_millis(60)).await;
                        let _=write_rate_configuration(&recovery_peripheral,&recovery_write_char,rate).await;
                        selected_transmit_interval.store(0,Ordering::Relaxed);
                    }
                    continue;
                }
                let requested_sample_rate = selected_sample_rate.load(Ordering::Relaxed);
                if requested_sample_rate != active_sample_rate {
                    active_sample_rate = requested_sample_rate;
                    decoder.set_sample_rate(active_sample_rate);
                    rate_window.clear();diagnostic_origin=Instant::now();
                    // Preserve monotonicity across a rate change; the first
                    // new interval may differ by at most one old sample period.
                }
                let rows = decoder.push(&notification.value);
                let packet_samples=decoder.last_received_samples();
                let integrity=inspect_td_payload(&notification.value).unwrap_or_default();
                let usable_samples=rows.iter().filter(|row|row.observed&&row.valid&&row.packet.eeg.as_ref().is_some_and(|e|e.eeg1!=0||e.eeg2!=0||e.eeg3!=0||e.eeg4!=0)).count();
                let diagnostic_now=Instant::now();
                rate_window.push_back((arrival_instant,packet_samples,rows.len(),usize::from(packet_samples==0),integrity,usable_samples));
                while rate_window.front().is_some_and(|p|diagnostic_now.duration_since(p.0).as_secs_f64()>10.0){rate_window.pop_front();}
                let processing_delay_ms=diagnostic_now.saturating_duration_since(arrival_instant).as_millis().min(i64::MAX as u128) as i64;
                peak_processing_delay_ms=peak_processing_delay_ms.max(processing_delay_ms);
                let diagnostic_seconds=diagnostic_started.elapsed().as_secs_f64();
                if diagnostic_seconds>=1.0 {
                    if link_checked.elapsed() >= Duration::from_secs(5) {
                        refresh_platform_link(&recovery_peripheral, &mut platform_link).await;
                        link_checked=Instant::now();
                    }
                    let window_seconds=diagnostic_origin.elapsed().as_secs_f64().min(10.0).max(0.001);
                    let sums=rate_window.iter().fold((0usize,0usize,0usize),|a,p|(a.0+p.1,a.1+p.2,a.2+p.3));
                    let payload_sums=rate_window.iter().fold((0usize,0usize,0usize,0usize,0usize),|a,p|(a.0+p.4.sample_slots,a.1+p.4.all_channel_zero_slots,a.2+p.4.identical_adjacent_slots,a.3+usize::from(p.4.sample_slots>=4&&p.4.trailing_zero_slots>=p.4.sample_slots/2),a.4+p.5));
                    let transmit_interval_ms=selected_transmit_interval.load(Ordering::Relaxed);
                    let expected=0;
                    let _=task_app.emit("ble://diagnostics",crate::models::BleDiagnosticsEvent {
                        link_request_status: platform_link.status.clone(),
                        connection_interval_ms: platform_link.interval_ms,
                        peripheral_latency: platform_link.latency,
                        received_slot_rate_hz:payload_sums.0 as f64/window_seconds,
                        usable_eeg_sample_rate_hz:payload_sums.4 as f64/window_seconds,
                        zero_adc_slots:payload_sums.1,
                        identical_adjacent_adc_slots:payload_sums.2,
                        suspicious_notifications:payload_sums.3,
                        rtc_raw:integrity.rtc_raw,
                        window_seconds,transmit_interval_ms,expected_samples_per_notification:expected,
                        packing_confirmed:packet_samples==expected&&expected>0,
                        notification_rate_hz:rate_window.iter().filter(|p|p.1>0).count() as f64/window_seconds,
                        observed_sample_rate_hz:sums.0 as f64/window_seconds,
                        logical_sample_rate_hz:sums.1 as f64/window_seconds,
                        requested_sample_rate_hz:active_sample_rate,
                        samples_per_notification:packet_samples,
                        buffered_notifications:notifications.receiver.len(),
                        processing_delay_ms,peak_processing_delay_ms,
                        rejected_notifications:sums.2,
                    });
                    diagnostic_started=Instant::now();peak_processing_delay_ms=0;
                }
                if rows.is_empty() {
                    if data_notifications == 0 {
                        rejected_notifications_before_data += 1;
                        if rejected_notifications_before_data == 3 {
                            let prefix = notification
                                .value
                                .iter()
                                .take(4)
                                .map(|byte| format!("{byte:02X}"))
                                .collect::<Vec<_>>()
                                .join(" ");
                            let _ = task_app.emit(
                                "ble://status",
                                crate::models::StatusEvent {
                                    message: format!(
                                        "FFF9收到但协议解析失败：长度 {} 字节，帧头 {}",
                                        notification.value.len(),
                                        prefix
                                    ),
                                    connected: true,
                                },
                            );
                        }
                    }
                    continue;
                }
                if data_notifications == 0 {
                    let _ = task_app.emit(
                        "ble://status",
                        crate::models::StatusEvent {
                            message: format!(
                                "EEG数据流已恢复：每通知 {} 个样本，当前 {} Hz",
                                rows.len(),
                                active_sample_rate
                            ),
                            connected: true,
                        },
                    );
                }
                data_notifications += 1;
                let now = arrival_time;
                // 一包多数据代表到达通知之前的一段采样；让最后一个样本落在
                // 主机实际接收时刻，避免把整包样本写到未来。
                let interval_ns = sample_interval_nanoseconds(active_sample_rate);
                let packet_start =
                    arrival_aligned_packet_start(now, rows.len(), active_sample_rate);
                next_sample_timestamp = Some(raw_packet_start(
                    next_sample_timestamp, packet_start,
                ));
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
                        observed: row.observed,
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

                // LSL 使用独立有界队列，接收端过慢时只丢 LSL 批次，绝不阻塞 BLE 与写盘。
                lsl_publisher.publish_samples(&sample_events, active_sample_rate);
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
        let _lifecycle=self.lifecycle_lock.lock().await;
        self.disconnect_device_inner().await
    }

    async fn disconnect_device_inner(&self) -> Result<()> {
        let (peripheral, task) = {
            let mut inner = self.inner.lock().await;
            (inner.peripheral.take(), inner.notify_task.take())
        };
        let cleanup_target = peripheral.clone();

        // Keep draining while disabling notifications and cancelling the link.
        // Stop our tasks afterwards, including when the platform fails to reply.
        let result=if let Some(peripheral)=peripheral {
            let connected=bounded_ble_operation("检查蓝牙连接",Duration::from_secs(2),peripheral.is_connected()).await;
            if matches!(connected,Ok(false)){Ok(())}else{
                restore_platform_link(&peripheral).await;
                if let Some(tx)=peripheral.characteristics().into_iter().find(|ch|ch.service_uuid==PPG_SERVICE_UUID&&ch.uuid==PPG_TX_UUID){
                    let _=bounded_ble_operation("关闭FFF9通知",Duration::from_secs(2),peripheral.unsubscribe(&tx)).await;
                }
                bounded_ble_operation("释放蓝牙连接",Duration::from_secs(3),peripheral.disconnect()).await
            }
        }else{Ok(())};
        if let Some(task)=task {task.abort();}

        let mut inner = self.inner.lock().await;
        inner.write_char = None;
        if result.is_err(){
            inner.adapter=None;
            // Retain the unresolved link so the next connect must retry its
            // release instead of silently treating a timed-out close as done.
            inner.peripheral=cleanup_target;
        }
        result
    }

    pub async fn send_command(&self, hex: String) -> Result<()> {
        let bytes = parse_hex(&hex)?;
        if let [0x72,parameter]=bytes.as_slice(){
            if (1..=4).contains(parameter){return self.set_sample_rate([125,250,500,1000][(*parameter-1) as usize]).await;}
        }
        if bytes.first()==Some(&0x93){
            return Err(anyhow!("TD数据帧格式(3)不包含0x93；旧扩包实验出现无效数据，已停用该命令"));
        }
        let _commands=self.command_lock.lock().await;
        self.write_bytes(&bytes).await?;
        Ok(())
    }

    pub async fn set_sample_rate(&self, sample_rate_hz: u32) -> Result<()> {
        let _command = sample_rate_command(sample_rate_hz)
            .ok_or_else(|| anyhow!("不支持的采样率 {sample_rate_hz} Hz"))?;
        debug_assert!(samples_per_notification(sample_rate_hz).is_some());
        // Re-arm the stream around a rate change.  This also recovers TD10
        // units that stay connected and keep reporting battery, but stop EEG.
        let _commands=self.command_lock.lock().await;
        let (peripheral,write_char)={let inner=self.inner.lock().await;(inner.peripheral.clone().ok_or_else(||anyhow!("尚未连接设备"))?,inner.write_char.clone().ok_or_else(||anyhow!("缺少FFF5"))?)};
        write_rate_configuration(&peripheral,&write_char,sample_rate_hz).await?;
        self.sample_rate_hz.store(sample_rate_hz, Ordering::Relaxed);
        self.transmit_interval_ms.store(0,Ordering::Relaxed);
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
        write_supported_command(&peripheral,&write_char,bytes).await?;
        Ok(())
    }

    pub async fn start_recording(&self, directory: Option<String>) -> Result<String> {
        let mut recorder = self.recorder.lock().await;
        if recorder.is_some() { return Err(anyhow!("记录已开启，请先停止当前记录")); }
        let dir = directory
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?.join("recordings"));
        fs::create_dir_all(&dir)?;

        let filename = format!("ppg_eeg_log_{}.csv", Local::now().format("%Y%m%d_%H%M%S_%3f"));
        let path = dir.join(filename);
        let file = File::create(&path)?;
        let mut writer = BufWriter::new(file);
        writeln!(
            writer,
            "time,sampleRateHz,seq,ir1,red1,green1,ir2,red2,green2,accX,accY,accZ,eeg1,eeg2,eeg3,eeg4,flag,valid,deviceSeq,observed"
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

        *recorder = Some(Recorder {
            path: path.clone(),
            writer,
            marker_writer,
            marker_path,
            last_flush: Instant::now(),
            sample_count: 0,
            sample_index: VecDeque::new(),
        });
        Ok(path.to_string_lossy().to_string())
    }

    pub async fn stop_recording(&self) -> Result<()> {
        let mut recorder = self.recorder.lock().await;
        if let Some(recording) = recorder.as_mut() {
            recording.writer.flush()?;
            recording.marker_writer.flush()?;
            recording.writer.get_ref().sync_data()?;
            recording.marker_writer.get_ref().sync_data()?;
        }
        *recorder = None;
        Ok(())
    }

    pub async fn stimulus_recording_path(&self) -> Result<PathBuf> {
        let recorder = self.recorder.lock().await;
        let recording = recorder.as_ref().ok_or_else(|| anyhow!("请先开始 EEG 数据记录"))?;
        Ok(recording.path.clone())
    }

    /// This is a host-logical EEG position, not an ADC hardware timestamp.
    pub async fn append_stimulus_marker(
        &self, expected_path: &std::path::Path, event_time_unix_s: f64,
        label: &str, note: &str,
    ) -> Result<StimulusAlignment> {
        let mut recorder = self.recorder.lock().await;
        let recording = recorder.as_mut().ok_or_else(|| anyhow!("EEG 记录已停止，事件未确认"))?;
        if recording.path != expected_path {
            return Err(anyhow!("EEG 记录文件已经改变，事件未确认"));
        }
        let nearest = recording.sample_index.iter().min_by(|a, b|
            (a.0 - event_time_unix_s).abs().total_cmp(&(b.0 - event_time_unix_s).abs())
        ).copied();
        let alignment = StimulusAlignment {
            nearest_received_sample_index: nearest.map(|x| x.1),
            nearest_received_sample_time_unix_s: nearest.map(|x| x.0),
            alignment_error_ms: nearest.map(|x| (x.0 - event_time_unix_s) * 1000.0),
        };
        let micros = (event_time_unix_s * 1e6).round() as i64;
        let timestamp = DateTime::<Utc>::from_timestamp_micros(micros)
            .ok_or_else(|| anyhow!("刺激时间戳无效"))?;
        // Use the same explicit local offset as the EEG CSV, not a UTC-only
        // marker string that looks eight hours earlier in spreadsheet tools.
        let timestamp = local_rfc3339(timestamp);
        writeln!(recording.marker_writer, "{},MATLAB,{},{},{},,MATLAB自动标记,,,,",
            timestamp, csv_field(label), csv_field(note),
            alignment.nearest_received_sample_index.map(|x| x.to_string()).unwrap_or_default())?;
        recording.marker_writer.flush()?;
        recording.marker_writer.get_ref().sync_data()?;
        Ok(alignment)
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
        let (cached, init_error) = { let inner = self.inner.lock().await; (inner.adapter.clone(), inner.adapter_init_error.clone()) };
        if let Some(adapter) = cached {
            return Ok(adapter);
        }
        if let Some(error) = init_error { return Err(anyhow!(error)); }

        let manager = Manager::new().await?;
        let adapters = match tokio::time::timeout(Duration::from_secs(10), manager.adapters()).await {
            Ok(result) => result?,
            Err(_) => {
                // First-use macOS authorization can leave the library waiting
                // for its first state callback. Latch this failure so automatic
                // retries do not create a new native thread every second.
                let message = "蓝牙初始化超时。请在系统蓝牙隐私权限中允许此版本，然后关闭并重新打开上位机".to_string();
                self.inner.lock().await.adapter_init_error = Some(message.clone());
                return Err(anyhow!(message));
            }
        };
        let adapter = adapters
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
            self.remember_peripheral(&peripheral).await;
            return Ok(peripheral);
        }

        // macOS can retrieve a previously scanned UUID without waiting for
        // another advertisement. Cache only TD identifiers owned by this app.
        let known_id={self.inner.lock().await.known_ids.get(device_id).cloned()};
        if let Some(id)=known_id {
            if let Ok(Ok(found))=tokio::time::timeout(Duration::from_secs(3),adapter.retrieve_peripherals(RetrievePeripheralsOptions{identifiers:Some(vec![id]),services:None})).await{
                if let Some(peripheral)=found.into_iter().find(|p|p.id().to_string()==device_id){return Ok(peripheral);}
            }
        }

        // 兜底：扫描期间轮询 peripherals()，命中即返回，避免固定 sleep 拖慢连接
        bounded_ble_operation("开始连接扫描", Duration::from_secs(3), adapter.start_scan(ScanFilter::default())).await?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(peripheral) = adapter
                .peripherals()
                .await?
                .into_iter()
                .find(|peripheral| peripheral.id().to_string() == device_id)
            {
                let _ = bounded_ble_operation("停止连接扫描", Duration::from_secs(2), adapter.stop_scan()).await;
                self.remember_peripheral(&peripheral).await;
                return Ok(peripheral);
            }
            if Instant::now() >= deadline {
                let _ = bounded_ble_operation("停止连接扫描", Duration::from_secs(2), adapter.stop_scan()).await;
                return Err(anyhow!("未找到目标设备: {device_id}"));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    async fn remember_peripheral(&self, peripheral: &Peripheral) {
        let mut inner = self.inner.lock().await;
        remember_td_identifier(&mut inner.known_ids, peripheral.id().to_string(), peripheral.id());
    }
}

// Keep only a bounded set of scanned/selected TD identifiers. Unlike a new
// scan, the public retrieval API can recover a known macOS UUID immediately.
fn remember_td_identifier(cache: &mut BTreeMap<String, PeripheralId>, key: String, id: PeripheralId) {
    const MAX_KNOWN_TD_DEVICES: usize = 64;
    if !cache.contains_key(&key) && cache.len() >= MAX_KNOWN_TD_DEVICES {
        if let Some(evicted_key) = cache.keys().next().cloned() { cache.remove(&evicted_key); }
    }
    cache.insert(key, id);
}

async fn bounded_ble_operation<T>(name:&str,timeout:Duration,operation:impl std::future::Future<Output=btleplug::Result<T>>)->Result<T>{
    tokio::time::timeout(timeout,operation).await.map_err(|_|anyhow!("{name}超时；本地操作已停止，若仍显示占用请重启上位机"))?.map_err(Into::into)
}

struct PlatformLinkInfo { status: String, interval_ms: Option<f64>, latency: Option<u16> }

async fn configure_platform_link(peripheral: &Peripheral) -> PlatformLinkInfo {
    let mut info = PlatformLinkInfo { status: "系统协商；macOS没有公开中央设备连接优先级接口，未强制修改".into(), interval_ms: None, latency: None };
    #[cfg(target_os = "windows")]
    {
        // Windows 11 public API, analogous to Android's high-throughput
        // preference. Older systems/drivers may reject it; keep receiving.
        info.status = match bounded_ble_operation("Windows高吞吐请求", Duration::from_secs(2), peripheral.request_connection_parameters(btleplug::api::ConnectionParameterPreset::ThroughputOptimized)).await {
            Ok(()) => "Windows高吞吐请求已受理；不等于实际连接参数或采样率已达标".into(),
            Err(error) => format!("Windows高吞吐请求不可用，继续系统协商：{error}"),
        };
    }
    refresh_platform_link(peripheral, &mut info).await;
    info
}

async fn refresh_platform_link(peripheral: &Peripheral, info: &mut PlatformLinkInfo) {
    #[cfg(target_os = "windows")]
    if let Ok(Some(params)) = bounded_ble_operation("读取Windows连接参数", Duration::from_secs(1), peripheral.connection_parameters()).await {
        info.interval_ms = Some(params.interval_us as f64 / 1000.0);
        info.latency = Some(params.latency);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (peripheral, info);
}

async fn restore_platform_link(peripheral: &Peripheral) {
    #[cfg(target_os = "windows")]
    let _ = bounded_ble_operation("恢复Windows系统连接偏好", Duration::from_secs(2), peripheral.request_connection_parameters(btleplug::api::ConnectionParameterPreset::Balanced)).await;
    #[cfg(not(target_os = "windows"))]
    let _ = peripheral;
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
    for event in events {
        recording.sample_count += 1;
        if let Ok(time) = DateTime::parse_from_rfc3339(&event.timestamp) {
            recording.sample_index.push_back((time.timestamp_micros() as f64 / 1e6, recording.sample_count));
        }
    }
    // At most 120 seconds at the maximum supported 1 kHz; no whole-night growth.
    while recording.sample_index.len() > 120_000 {
        recording.sample_index.pop_front();
    }
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
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
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
                .unwrap_or_default(),
            event.observed
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
fn monotonic_packet_start(
    next: Option<DateTime<Utc>>,
    arrival_start: DateTime<Utc>,
) -> DateTime<Utc> {
    match next {
        // A late notification may indicate a real interruption. Advance the
        // host-logical clock, but never rewind it on a burst, jitter or a wall
        // clock adjustment: that made finalized markers ambiguous.
        Some(next) if arrival_start.signed_duration_since(next).num_milliseconds()
            > SAMPLE_CLOCK_REANCHOR_THRESHOLD_MS => arrival_start,
        Some(next) => next,
        None => arrival_start,
    }
}

fn raw_packet_start(next:Option<DateTime<Utc>>,arrival_start:DateTime<Utc>)->DateTime<Utc>{
    match next {
        // Keep packet jitter/bursts monotonic, but preserve real gaps promptly.
        // The old 250 ms anchor compressed raw-only under-reception into a
        // falsely continuous target-rate timeline.
        Some(next) if arrival_start.signed_duration_since(next).num_microseconds().unwrap_or(i64::MAX)>5_000=>arrival_start,
        Some(next)=>next,
        None=>arrival_start,
    }
}

async fn write_rate_configuration(peripheral:&Peripheral,characteristic:&Characteristic,rate:u32)->Result<()> {
    for command in documented_rate_commands(rate).ok_or_else(||anyhow!("不支持的采样率"))?{
        if write_supported_command(peripheral,characteristic,&command).await.is_err(){
            tokio::time::sleep(Duration::from_millis(250)).await;
            write_supported_command(peripheral,characteristic,&command).await?;
        }
    }
    Ok(())
}

fn supported_write_type(properties:CharPropFlags)->Result<WriteType>{
    if properties.contains(CharPropFlags::WRITE){Ok(WriteType::WithResponse)}
    else if properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE){Ok(WriteType::WithoutResponse)}
    else {Err(anyhow!("FFF5未声明可写入属性"))}
}

async fn write_supported_command(peripheral:&Peripheral,characteristic:&Characteristic,bytes:&[u8])->Result<()> {
    // WithoutResponse previously returned success even though this TD's FFF5
    // advertises WRITE only. An ATT response is acknowledgement of the write,
    // not proof of ADC sampling frequency or independent sample acquisition.
    let kind=supported_write_type(characteristic.properties)?;
    tokio::time::timeout(Duration::from_secs(3),peripheral.write(characteristic,bytes,kind)).await.map_err(|_|anyhow!("FFF5写入响应超时"))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        arrival_aligned_packet_start, monotonic_packet_start, is_td_device_name, local_rfc3339, parse_hex,
        write_battery_row, write_record_rows, BleManagerState,
    };
    use crate::battery::BatteryLevel;
    use crate::models::{BatteryEvent, DecodedPacket, EegSample, PpgSample, SampleEvent};
    use chrono::{DateTime, Duration as ChronoDuration, Local, TimeZone, Utc};
    use uuid::Uuid;

    #[tokio::test]
    async fn platform_operations_have_bounded_waits() {
        let result = super::bounded_ble_operation::<()>("测试蓝牙操作", std::time::Duration::from_millis(10), std::future::pending()).await;
        assert!(result.unwrap_err().to_string().contains("测试蓝牙操作超时"));
        assert_eq!(super::bounded_ble_operation("立即成功", std::time::Duration::from_secs(1), async { Ok(42) }).await.unwrap(), 42);
        assert!(super::bounded_ble_operation::<()>("平台错误", std::time::Duration::from_secs(1), async { Err(btleplug::Error::NotSupported("test".into())) }).await.is_err());
    }

    #[tokio::test]
    async fn connection_lifecycle_operations_do_not_overlap() {
        let state = std::sync::Arc::new(BleManagerState::default());
        let guard = state.lifecycle_lock.lock().await;
        let worker_state = state.clone();
        let worker = tokio::spawn(async move { let _guard = worker_state.lifecycle_lock.lock().await; 1 });
        tokio::task::yield_now().await;
        assert!(!worker.is_finished());
        drop(guard);
        assert_eq!(worker.await.unwrap(), 1);
    }

    #[tokio::test]
    async fn initialization_timeout_is_latched_without_starting_more_native_threads() {
        let state = BleManagerState::default();
        state.inner.lock().await.adapter_init_error = Some("已锁定初始化失败，请授权后重启".into());
        for _ in 0..3 {
            let error = state.ensure_adapter().await.unwrap_err();
            assert!(error.to_string().contains("请授权后重启"));
        }
    }

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

    #[tokio::test]
    async fn ingress_queue_is_bounded_and_preserves_every_notification_in_order() {
        let source=futures::stream::iter((0..4096u32).map(|index|btleplug::api::ValueNotification {
            uuid:super::PPG_TX_UUID,service_uuid:super::PPG_SERVICE_UUID,value:index.to_be_bytes().to_vec(),
        }));
        let mut buffered=super::buffer_notifications(Box::pin(source));
        tokio::task::yield_now().await;
        assert!(buffered.receiver.len()<=super::NOTIFICATION_QUEUE_CAPACITY);
        for expected in 0..4096u32 {
            let (notification,arrival,captured)=tokio::time::timeout(std::time::Duration::from_secs(1),buffered.receiver.recv()).await.unwrap().unwrap();
            assert_eq!(notification.value,expected.to_be_bytes());assert!(arrival<=Utc::now());assert!(captured<=std::time::Instant::now());
        }
        assert!(buffered.receiver.recv().await.is_none());
    }

    #[test]
    fn jitter_or_clock_rewind_never_makes_eeg_time_go_backwards() {
        let next = Utc.with_ymd_and_hms(2026, 10, 13, 8, 0, 0).unwrap();
        assert_eq!(monotonic_packet_start(Some(next), next-ChronoDuration::seconds(1)), next);
        assert_eq!(monotonic_packet_start(Some(next), next+ChronoDuration::milliseconds(50)), next);
        assert_eq!(monotonic_packet_start(Some(next), next+ChronoDuration::seconds(1)), next+ChronoDuration::seconds(1));
        for rate in [125,250,500,1000] {
            let period=ChronoDuration::nanoseconds(super::sample_interval_nanoseconds(rate));
            let start=monotonic_packet_start(Some(next+period),next-ChronoDuration::seconds(1));
            assert!(start>next);
        }
    }

    #[test]
    fn raw_timebase_preserves_transport_gaps_without_creating_samples() {
        let next=Utc.with_ymd_and_hms(2026,10,14,8,0,0).unwrap();
        assert_eq!(super::raw_packet_start(Some(next),next+ChronoDuration::milliseconds(16)),next+ChronoDuration::milliseconds(16));
        assert_eq!(super::raw_packet_start(Some(next),next+ChronoDuration::milliseconds(3)),next);
        assert_eq!(super::raw_packet_start(Some(next),next-ChronoDuration::milliseconds(30)),next);
    }

    #[test]
    fn write_kind_follows_fff5_properties_instead_of_forcing_no_response(){
        assert_eq!(super::supported_write_type(btleplug::api::CharPropFlags::WRITE).unwrap(),btleplug::api::WriteType::WithResponse);
        assert_eq!(super::supported_write_type(btleplug::api::CharPropFlags::WRITE_WITHOUT_RESPONSE).unwrap(),btleplug::api::WriteType::WithoutResponse);
        assert_eq!(super::supported_write_type(btleplug::api::CharPropFlags::WRITE|btleplug::api::CharPropFlags::WRITE_WITHOUT_RESPONSE).unwrap(),btleplug::api::WriteType::WithResponse);
        assert!(super::supported_write_type(btleplug::api::CharPropFlags::empty()).is_err());
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

    #[tokio::test]
    async fn matlab_marker_timestamp_uses_the_same_format_as_eeg() {
        let directory=std::env::temp_dir().join(format!("ifet-marker-time-test-{}",Uuid::new_v4()));
        let state=BleManagerState::default();
        let path=std::path::PathBuf::from(state.start_recording(Some(directory.to_string_lossy().into())).await.unwrap());
        let utc=Utc.with_ymd_and_hms(2026,10,13,2,3,4).unwrap();
        state.append_stimulus_marker(&path,utc.timestamp_micros() as f64/1e6,"声刺激开始","test").await.unwrap();
        state.stop_recording().await.unwrap();
        let marker=path.with_file_name(format!("{}_markers.csv",path.file_stem().unwrap().to_string_lossy()));
        let mut reader=csv::Reader::from_path(marker).unwrap();
        let row=reader.records().next().unwrap().unwrap();
        assert_eq!(&row[0],local_rfc3339(utc));
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
            observed: true,
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
