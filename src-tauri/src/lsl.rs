use crate::models::SampleEvent;
use lsl::{ChannelFormat, Pushable, StreamInfo, StreamOutlet, IRREGULAR_RATE};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::sync::oneshot;

const DATA_QUEUE_CAPACITY: usize = 256;
const STATUS_REFRESH_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LslConfig {
    pub enabled: bool,
    pub stream_name: String,
    pub source_id: String,
    pub sample_rate_hz: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LslStreamSummary {
    pub name: String,
    pub stream_type: String,
    pub channel_count: u32,
    pub nominal_sample_rate_hz: f64,
    pub channel_format: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LslStatus {
    pub enabled: bool,
    pub running: bool,
    pub has_consumers: bool,
    pub message: String,
    pub stream_name: String,
    pub source_id: String,
    pub sample_rate_hz: u32,
    pub samples_published: u64,
    pub markers_published: u64,
    pub dropped_batches: u64,
    pub protocol_version: String,
    pub library_version: String,
    pub last_error: Option<String>,
    pub streams: Vec<LslStreamSummary>,
}

impl Default for LslStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            running: false,
            has_consumers: false,
            message: "LSL 未启用".to_string(),
            stream_name: "iFET-TD10".to_string(),
            source_id: "ifet-td10-headset".to_string(),
            sample_rate_hz: 125,
            samples_published: 0,
            markers_published: 0,
            dropped_batches: 0,
            protocol_version: format_version(lsl::protocol_version()),
            library_version: format_version(lsl::library_version()),
            last_error: None,
            streams: Vec::new(),
        }
    }
}

pub struct LslManagerState {
    control_tx: mpsc::Sender<ControlMessage>,
    publisher: LslPublisher,
    status: Arc<RwLock<LslStatus>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct LslPublisher {
    data_tx: SyncSender<DataMessage>,
    dropped_batches: Arc<AtomicU64>,
    enabled: Arc<AtomicBool>,
}

impl Default for LslManagerState {
    fn default() -> Self {
        let (control_tx, control_rx) = mpsc::channel();
        let (data_tx, data_rx) = mpsc::sync_channel(DATA_QUEUE_CAPACITY);
        let status = Arc::new(RwLock::new(LslStatus::default()));
        let dropped_batches = Arc::new(AtomicU64::new(0));
        let enabled = Arc::new(AtomicBool::new(false));
        let worker_status = Arc::clone(&status);
        let worker_dropped = Arc::clone(&dropped_batches);
        let worker = thread::Builder::new()
            .name("ifet-lsl-outlet".to_string())
            .spawn(move || worker_loop(control_rx, data_rx, worker_status, worker_dropped))
            .expect("failed to start LSL outlet worker");
        Self {
            control_tx,
            publisher: LslPublisher {
                data_tx,
                dropped_batches,
                enabled,
            },
            status,
            worker: Mutex::new(Some(worker)),
        }
    }
}

impl LslManagerState {
    pub fn publisher(&self) -> LslPublisher {
        self.publisher.clone()
    }

    pub fn status(&self) -> LslStatus {
        let mut snapshot = self
            .status
            .read()
            .expect("LSL status lock poisoned")
            .clone();
        snapshot.dropped_batches = self.publisher.dropped_batches.load(Ordering::Relaxed);
        snapshot
    }

    pub async fn configure(&self, config: LslConfig) -> Result<LslStatus, String> {
        let config = validate_config(config)?;
        let (reply_tx, reply_rx) = oneshot::channel();
        self.control_tx
            .send(ControlMessage::Configure {
                config,
                reply: reply_tx,
            })
            .map_err(|_| "LSL 后台线程已停止".to_string())?;
        let result = reply_rx
            .await
            .map_err(|_| "LSL 后台线程无响应".to_string())?;
        self.publisher.enabled.store(
            result.as_ref().is_ok_and(|status| status.running),
            Ordering::Relaxed,
        );
        result
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn publish_marker(
        &self,
        label: String,
        note: String,
        participant_id: String,
        sample_count: u64,
        device_flag: Option<u8>,
        algorithm_action: String,
    ) -> Result<LslStatus, String> {
        let marker = serde_json::json!({
            "label": label,
            "note": note,
            "participantId": participant_id,
            "sampleCount": sample_count,
            "deviceFlag": device_flag,
            "algorithmAction": algorithm_action,
            "wallClockUtc": chrono::Utc::now().to_rfc3339(),
        })
        .to_string();
        let (reply_tx, reply_rx) = oneshot::channel();
        self.control_tx
            .send(ControlMessage::PublishMarker {
                marker,
                reply: reply_tx,
            })
            .map_err(|_| "LSL 后台线程已停止".to_string())?;
        reply_rx
            .await
            .map_err(|_| "LSL 后台线程无响应".to_string())?
    }
}

impl Drop for LslManagerState {
    fn drop(&mut self) {
        let _ = self.control_tx.send(ControlMessage::Shutdown);
        if let Some(worker) = self.worker.lock().ok().and_then(|mut value| value.take()) {
            let _ = worker.join();
        }
    }
}

impl LslPublisher {
    pub fn publish_samples(&self, events: &[SampleEvent], sample_rate_hz: u32) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let batch = LslSampleBatch::from_events(events);
        if batch.eeg.is_empty() {
            return;
        }
        match self.data_tx.try_send(DataMessage::Samples {
            batch,
            sample_rate_hz,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.dropped_batches.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

enum ControlMessage {
    Configure {
        config: LslConfig,
        reply: oneshot::Sender<Result<LslStatus, String>>,
    },
    PublishMarker {
        marker: String,
        reply: oneshot::Sender<Result<LslStatus, String>>,
    },
    Shutdown,
}

enum DataMessage {
    Samples {
        batch: LslSampleBatch,
        sample_rate_hz: u32,
    },
}

#[derive(Debug, Default, PartialEq)]
struct LslSampleBatch {
    eeg: Vec<Vec<i32>>,
    aux: Vec<Vec<i32>>,
    quality: Vec<Vec<i32>>,
}

impl LslSampleBatch {
    fn from_events(events: &[SampleEvent]) -> Self {
        let mut batch = Self::default();
        for event in events {
            let Some(eeg) = event.packet.eeg.as_ref() else {
                continue;
            };
            batch.eeg.push(vec![
                signed_u24(eeg.eeg1),
                signed_u24(eeg.eeg2),
                signed_u24(eeg.eeg3),
                signed_u24(eeg.eeg4),
            ]);
            batch.aux.push(vec![
                event.packet.ppg.ir1 as i32,
                event.packet.ppg.red1 as i32,
                event.packet.ppg.green1 as i32,
                event.packet.ppg.ir2 as i32,
                event.packet.ppg.red2 as i32,
                event.packet.ppg.green2 as i32,
                event.packet.ppg.acc_x as i32,
                event.packet.ppg.acc_y as i32,
                event.packet.ppg.acc_z as i32,
            ]);
            batch.quality.push(vec![
                if event.valid { 1 } else { 0 },
                event.device_sequence.map(i32::from).unwrap_or(-1),
                eeg.flag.map(i32::from).unwrap_or(-1),
            ]);
        }
        batch
    }
}

struct Outlets {
    eeg: StreamOutlet,
    aux: StreamOutlet,
    quality: StreamOutlet,
    markers: StreamOutlet,
    summaries: Vec<LslStreamSummary>,
}

impl Outlets {
    fn new(config: &LslConfig) -> Result<Self, String> {
        let eeg_channels = [
            ChannelDescription::new("EEG1", "EEG", "ADC counts"),
            ChannelDescription::new("EEG2", "EEG", "ADC counts"),
            ChannelDescription::new("EEG3", "EEG", "ADC counts"),
            ChannelDescription::new("EEG4", "EEG", "ADC counts"),
        ];
        let aux_channels = [
            ChannelDescription::new("IR1", "PPG", "ADC counts"),
            ChannelDescription::new("Red1", "PPG", "ADC counts"),
            ChannelDescription::new("Green1", "PPG", "ADC counts"),
            ChannelDescription::new("IR2", "PPG", "ADC counts"),
            ChannelDescription::new("Red2", "PPG", "ADC counts"),
            ChannelDescription::new("Green2", "PPG", "ADC counts"),
            ChannelDescription::new("AccX", "Accelerometer", "device counts"),
            ChannelDescription::new("AccY", "Accelerometer", "device counts"),
            ChannelDescription::new("AccZ", "Accelerometer", "device counts"),
        ];
        let quality_channels = [
            ChannelDescription::new("Valid", "Quality", "binary"),
            ChannelDescription::new("DeviceSeq", "Quality", "counter"),
            ChannelDescription::new("DeviceFlag", "Marker", "code"),
        ];
        let eeg_name = format!("{}_EEG", config.stream_name);
        let aux_name = format!("{}_AUX", config.stream_name);
        let quality_name = format!("{}_Quality", config.stream_name);
        let marker_name = format!("{}_Markers", config.stream_name);
        let rate = f64::from(config.sample_rate_hz);
        let eeg = create_numeric_outlet(
            &eeg_name,
            "EEG",
            rate,
            &format!("{}:eeg", config.source_id),
            &eeg_channels,
            "Signed 24-bit two's-complement raw ADC counts",
        )?;
        let aux = create_numeric_outlet(
            &aux_name,
            "AUX",
            rate,
            &format!("{}:aux", config.source_id),
            &aux_channels,
            "Raw PPG and accelerometer device counts",
        )?;
        let quality = create_numeric_outlet(
            &quality_name,
            "Quality",
            rate,
            &format!("{}:quality", config.source_id),
            &quality_channels,
            "Validity, device sequence and device flag aligned to each EEG sample",
        )?;
        let mut marker_info = StreamInfo::new(
            &marker_name,
            "Markers",
            1,
            IRREGULAR_RATE,
            ChannelFormat::String,
            &format!("{}:markers", config.source_id),
        )
        .map_err(lsl_error)?;
        add_common_metadata(
            &mut marker_info,
            &[ChannelDescription::new("Event", "Marker", "JSON string")],
            "Manual markers and blink/PSG alignment events as JSON",
        );
        let markers = StreamOutlet::new(&marker_info, 0, 360).map_err(lsl_error)?;
        let summaries = vec![
            summary(&eeg_name, "EEG", 4, rate, "int32"),
            summary(&aux_name, "AUX", 9, rate, "int32"),
            summary(&quality_name, "Quality", 3, rate, "int32"),
            summary(&marker_name, "Markers", 1, IRREGULAR_RATE, "string"),
        ];
        Ok(Self {
            eeg,
            aux,
            quality,
            markers,
            summaries,
        })
    }

    fn push(&self, batch: &LslSampleBatch) -> Result<(), String> {
        self.eeg.push_chunk(&batch.eeg).map_err(lsl_error)?;
        self.aux.push_chunk(&batch.aux).map_err(lsl_error)?;
        self.quality.push_chunk(&batch.quality).map_err(lsl_error)?;
        Ok(())
    }

    fn push_marker(&self, marker: &str) -> Result<(), String> {
        self.markers
            .push_sample(&vec![marker.to_string()])
            .map_err(lsl_error)
    }

    fn have_consumers(&self) -> bool {
        self.eeg.have_consumers()
            || self.aux.have_consumers()
            || self.quality.have_consumers()
            || self.markers.have_consumers()
    }
}

#[derive(Clone, Copy)]
struct ChannelDescription<'a> {
    label: &'a str,
    channel_type: &'a str,
    unit: &'a str,
}

impl<'a> ChannelDescription<'a> {
    const fn new(label: &'a str, channel_type: &'a str, unit: &'a str) -> Self {
        Self {
            label,
            channel_type,
            unit,
        }
    }
}

fn worker_loop(
    control_rx: Receiver<ControlMessage>,
    data_rx: Receiver<DataMessage>,
    status: Arc<RwLock<LslStatus>>,
    dropped_batches: Arc<AtomicU64>,
) {
    let mut active_config: Option<LslConfig> = None;
    let mut outlets: Option<Outlets> = None;
    loop {
        loop {
            match control_rx.try_recv() {
                Ok(ControlMessage::Configure { config, reply }) => {
                    let result =
                        configure_worker(&config, &mut active_config, &mut outlets, &status);
                    let _ = reply.send(result);
                }
                Ok(ControlMessage::PublishMarker { marker, reply }) => {
                    let result = match outlets.as_ref() {
                        Some(active) => active.push_marker(&marker).map(|()| {
                            update_status(&status, |next| {
                                next.markers_published += 1;
                                next.last_error = None;
                            });
                            current_status(&status, &dropped_batches)
                        }),
                        None => Err("请先启用 LSL 输出".to_string()),
                    };
                    if let Err(error) = &result {
                        record_error(&status, error.clone());
                    }
                    let _ = reply.send(result);
                }
                Ok(ControlMessage::Shutdown) | Err(TryRecvError::Disconnected) => return,
                Err(TryRecvError::Empty) => break,
            }
        }

        match data_rx.recv_timeout(STATUS_REFRESH_INTERVAL) {
            Ok(DataMessage::Samples {
                batch,
                sample_rate_hz,
            }) => {
                let needs_rebuild = active_config.as_ref().is_some_and(|config| {
                    config.enabled && config.sample_rate_hz != sample_rate_hz
                });
                if needs_rebuild {
                    if let Some(mut updated) = active_config.clone() {
                        updated.sample_rate_hz = sample_rate_hz;
                        let _ =
                            configure_worker(&updated, &mut active_config, &mut outlets, &status);
                    }
                }
                if let Some(active) = outlets.as_ref() {
                    match active.push(&batch) {
                        Ok(()) => update_status(&status, |next| {
                            next.samples_published += batch.eeg.len() as u64;
                            next.last_error = None;
                        }),
                        Err(error) => record_error(&status, error),
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }

        update_status(&status, |next| {
            next.dropped_batches = dropped_batches.load(Ordering::Relaxed);
            next.has_consumers = outlets.as_ref().is_some_and(Outlets::have_consumers);
            if next.last_error.is_some() {
                next.message = "LSL 输出异常".to_string();
            } else if next.running && next.has_consumers {
                next.message = "LSL 接收端已连接".to_string();
            } else if next.running {
                next.message = "LSL 已发布，等待接收端".to_string();
            }
        });
    }
}

fn configure_worker(
    config: &LslConfig,
    active_config: &mut Option<LslConfig>,
    outlets: &mut Option<Outlets>,
    status: &Arc<RwLock<LslStatus>>,
) -> Result<LslStatus, String> {
    if active_config.as_ref() == Some(config) {
        return Ok(status.read().expect("LSL status lock poisoned").clone());
    }
    if !config.enabled {
        *outlets = None;
        *active_config = Some(config.clone());
        update_status(status, |next| {
            next.enabled = false;
            next.running = false;
            next.has_consumers = false;
            next.message = "LSL 未启用".to_string();
            next.stream_name = config.stream_name.clone();
            next.source_id = config.source_id.clone();
            next.sample_rate_hz = config.sample_rate_hz;
            next.last_error = None;
            next.streams.clear();
        });
        return Ok(status.read().expect("LSL status lock poisoned").clone());
    }

    match Outlets::new(config) {
        Ok(next_outlets) => {
            let summaries = next_outlets.summaries.clone();
            *outlets = Some(next_outlets);
            *active_config = Some(config.clone());
            update_status(status, |next| {
                next.enabled = true;
                next.running = true;
                next.has_consumers = false;
                next.message = "LSL 已发布，等待接收端".to_string();
                next.stream_name = config.stream_name.clone();
                next.source_id = config.source_id.clone();
                next.sample_rate_hz = config.sample_rate_hz;
                next.last_error = None;
                next.streams = summaries;
            });
            Ok(status.read().expect("LSL status lock poisoned").clone())
        }
        Err(error) => {
            *outlets = None;
            *active_config = None;
            record_error(status, error.clone());
            Err(error)
        }
    }
}

fn create_numeric_outlet(
    name: &str,
    stream_type: &str,
    sample_rate_hz: f64,
    source_id: &str,
    channels: &[ChannelDescription<'_>],
    data_description: &str,
) -> Result<StreamOutlet, String> {
    let mut info = StreamInfo::new(
        name,
        stream_type,
        channels.len() as u32,
        sample_rate_hz,
        ChannelFormat::Int32,
        source_id,
    )
    .map_err(lsl_error)?;
    add_common_metadata(&mut info, channels, data_description);
    StreamOutlet::new(&info, 0, 60).map_err(lsl_error)
}

fn add_common_metadata(
    info: &mut StreamInfo,
    channels: &[ChannelDescription<'_>],
    data_description: &str,
) {
    let mut desc = info.desc();
    desc.append_child_value("manufacturer", "iFET");
    desc.append_child_value("model", "TD10");
    desc.append_child_value("transport", "BLE FFF9 to desktop LSL outlet");
    desc.append_child_value("data_description", data_description);
    desc.append_child_value("host_software", "iFET EEG Client Sleep LSL 0.2.27");
    let mut channel_list = desc.append_child("channels");
    for channel in channels {
        let mut node = channel_list.append_child("channel");
        node.append_child_value("label", channel.label);
        node.append_child_value("type", channel.channel_type);
        node.append_child_value("unit", channel.unit);
    }
    let mut synchronization = desc.append_child("synchronization");
    synchronization.append_child_value("offset_mean", "0");
    synchronization.append_child_value("can_drop_samples", "true");
}

fn validate_config(mut config: LslConfig) -> Result<LslConfig, String> {
    config.stream_name = sanitize_text(&config.stream_name, 64);
    config.source_id = sanitize_text(&config.source_id, 96);
    if config.stream_name.is_empty() {
        return Err("LSL 流名称不能为空".to_string());
    }
    if config.source_id.is_empty() {
        return Err("LSL 来源 ID 不能为空".to_string());
    }
    if !matches!(config.sample_rate_hz, 125 | 250 | 500 | 1_000) {
        return Err(format!("LSL 不支持采样率 {} Hz", config.sample_rate_hz));
    }
    Ok(config)
}

fn sanitize_text(value: &str, limit: usize) -> String {
    value
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(limit)
        .collect()
}

fn signed_u24(value: u32) -> i32 {
    let value = value & 0x00ff_ffff;
    if value >= 0x0080_0000 {
        value as i32 - 0x0100_0000
    } else {
        value as i32
    }
}

fn summary(
    name: &str,
    stream_type: &str,
    channel_count: u32,
    nominal_sample_rate_hz: f64,
    channel_format: &str,
) -> LslStreamSummary {
    LslStreamSummary {
        name: name.to_string(),
        stream_type: stream_type.to_string(),
        channel_count,
        nominal_sample_rate_hz,
        channel_format: channel_format.to_string(),
    }
}

fn current_status(status: &Arc<RwLock<LslStatus>>, dropped_batches: &Arc<AtomicU64>) -> LslStatus {
    let mut snapshot = status.read().expect("LSL status lock poisoned").clone();
    snapshot.dropped_batches = dropped_batches.load(Ordering::Relaxed);
    snapshot
}

fn update_status(status: &Arc<RwLock<LslStatus>>, update: impl FnOnce(&mut LslStatus)) {
    let mut status = status.write().expect("LSL status lock poisoned");
    update(&mut status);
}

fn record_error(status: &Arc<RwLock<LslStatus>>, error: String) {
    update_status(status, |next| {
        next.running = false;
        next.has_consumers = false;
        next.message = "LSL 输出异常".to_string();
        next.last_error = Some(error);
    });
}

fn lsl_error(error: lsl::Error) -> String {
    format!("liblsl 错误: {error:?}")
}

fn format_version(version: i32) -> String {
    format!("{}.{}", version / 100, version % 100)
}

#[cfg(test)]
mod tests {
    use super::{signed_u24, validate_config, LslConfig, LslManagerState, LslSampleBatch};
    use crate::models::{DecodedPacket, EegSample, PpgSample, SampleEvent};
    use lsl::{Pullable, StreamInlet};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn converts_raw_unsigned_eeg_to_signed_lsl_counts() {
        let event = SampleEvent {
            timestamp: "2026-08-07T10:00:00+08:00".to_string(),
            sample_rate_hz: 125,
            valid: false,
            device_sequence: Some(7),
            packet: DecodedPacket {
                sequence: Some(7),
                ppg: PpgSample {
                    ir1: 1,
                    red1: 2,
                    green1: 3,
                    ir2: 4,
                    red2: 5,
                    green2: 6,
                    acc_x: -7,
                    acc_y: 8,
                    acc_z: -9,
                },
                eeg: Some(EegSample {
                    eeg1: 0x00ff_ffff,
                    eeg2: 0x0080_0000,
                    eeg3: 0x007f_ffff,
                    eeg4: 1,
                    flag: Some(14),
                }),
            },
        };
        let batch = LslSampleBatch::from_events(&[event]);
        assert_eq!(batch.eeg, vec![vec![-1, -8_388_608, 8_388_607, 1]]);
        assert_eq!(batch.aux, vec![vec![1, 2, 3, 4, 5, 6, -7, 8, -9]]);
        assert_eq!(batch.quality, vec![vec![0, 7, 14]]);
    }

    #[test]
    fn validates_stream_identity_and_supported_rate() {
        let config = validate_config(LslConfig {
            enabled: true,
            stream_name: "  iFET-TD10  ".to_string(),
            source_id: " headset-01 ".to_string(),
            sample_rate_hz: 1_000,
        })
        .unwrap();
        assert_eq!(config.stream_name, "iFET-TD10");
        assert_eq!(config.source_id, "headset-01");
        assert!(validate_config(LslConfig {
            sample_rate_hz: 200,
            ..config
        })
        .is_err());
    }

    #[test]
    fn signed_u24_obeys_twos_complement_boundary() {
        assert_eq!(signed_u24(0x007f_ffff), 8_388_607);
        assert_eq!(signed_u24(0x0080_0000), -8_388_608);
        assert_eq!(signed_u24(0x00ff_ffff), -1);
    }

    #[tokio::test]
    #[ignore = "opens local LSL network sockets; run explicitly as an integration smoke test"]
    async fn publishes_a_discoverable_four_channel_eeg_sample() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let source_id = format!("ifet-lsl-smoke-{unique}");
        let manager = LslManagerState::default();
        let status = manager
            .configure(LslConfig {
                enabled: true,
                stream_name: "iFET-LSL-Smoke".to_string(),
                source_id: source_id.clone(),
                sample_rate_hz: 125,
            })
            .await
            .unwrap();
        assert!(status.running);
        assert_eq!(status.streams.len(), 4);

        let streams =
            lsl::resolve_byprop("source_id", &format!("{source_id}:eeg"), 1, 3.0).unwrap();
        assert_eq!(streams.len(), 1);
        let inlet = StreamInlet::new(&streams[0], 5, 1, true).unwrap();
        inlet.open_stream(2.0).unwrap();

        manager.publisher().publish_samples(
            &[SampleEvent {
                timestamp: "2026-08-07T10:00:00+08:00".to_string(),
                sample_rate_hz: 125,
                valid: true,
                device_sequence: Some(9),
                packet: DecodedPacket {
                    sequence: Some(9),
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
                        eeg1: 1,
                        eeg2: 2,
                        eeg3: 3,
                        eeg4: 0x00ff_ffff,
                        flag: Some(14),
                    }),
                },
            }],
            125,
        );

        let (sample, timestamp): (Vec<i32>, f64) = inlet.pull_sample(3.0).unwrap();
        assert_eq!(sample, vec![1, 2, 3, -1]);
        assert!(timestamp > 0.0);
    }
}
