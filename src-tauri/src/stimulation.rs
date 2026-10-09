//! Audio uses native sample-clock timestamps; screen events use validated render acknowledgements.
use crate::ble::{BleManagerState, StimulusRecordingTarget};
use crate::stimulus_timeline::{Edge, EdgeKind, Timeline};
use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Local, SecondsFormat, Utc};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc::{self, Receiver, SyncSender}};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
#[path = "visual_stimulation.rs"]
mod visual;
use visual::{run_visual_experiment, VisualSession};
pub use visual::{monitor_names, VisualRendered};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StimulusConfig {
    #[serde(default = "default_modality")]
    pub modality: String,
    #[serde(default = "default_light_brightness")]
    pub light_brightness: f32,
    #[serde(default)]
    pub light_fullscreen: bool,
    #[serde(default)]
    pub light_monitor: String,
    pub source: String,
    pub wav_path: String,
    pub audio_device: String,
    pub serial_port: String,
    pub serial_enabled: bool,
    pub serial_on_offset: bool,
    pub duration_seconds: f64,
    pub cue_seconds: f64,
    pub rest_seconds: f64,
    pub trials: u32,
    pub blocks: u32,
    pub pause_between_blocks: bool,
    pub volume: f32,
    pub participant_id: String,
}
fn default_modality() -> String { "sound".into() }
fn default_light_brightness() -> f32 { 0.25 }

impl StimulusConfig {
    fn validate(&self) -> Result<()> {
        if !["sound", "light"].contains(&self.modality.as_str()) { bail!("请选择声音或屏幕光刺激"); }
        if !self.light_brightness.is_finite() || !(0.0..=0.8).contains(&self.light_brightness) { bail!("屏幕刺激亮度须为 0–80%"); }
        if !["wav", "test-tone"].contains(&self.source.as_str()) { bail!("请选择 WAV 或明确标注的测试音"); }
        if !self.volume.is_finite() || !(0.0..=0.8).contains(&self.volume) { bail!("音量必须在 0–80% 之间"); }
        if !self.duration_seconds.is_finite() || !(0.05..=120.0).contains(&self.duration_seconds) { bail!("刺激时长须为 0.05–120 秒"); }
        if !self.cue_seconds.is_finite() || !(0.05..=60.0).contains(&self.cue_seconds) { bail!("提示时间须为 0.05–60 秒"); }
        if !self.rest_seconds.is_finite() || !(0.05..=300.0).contains(&self.rest_seconds) { bail!("间隔须为 0.05–300 秒"); }
        if !(1..=100).contains(&self.trials) || !(1..=100).contains(&self.blocks) || self.trials * self.blocks > 1000 { bail!("组数/次数须为 1–100，总次数不超过 1000"); }
        if self.participant_id.len() > 128 { bail!("受试者标识过长"); }
        if self.serial_enabled && self.serial_port.trim().is_empty() { bail!("请先选择 Arduino 串口"); }
        if self.modality == "sound" && self.source == "wav" && self.wav_path.trim().is_empty() { bail!("请导入原始刺激 WAV；未提供 CochleaChirp.m 时不能重造 Don chirp"); }
        Ok(())
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StimulusStatus {
    pub active: bool,
    pub phase: String,
    pub message: String,
    pub run_id: String,
    pub block: u32,
    pub trial: u32,
    pub total_blocks: u32,
    pub total_trials: u32,
    pub marker_count: u32,
    pub log_path: String,
    pub marker_path: String,
    pub audio_device: String,
    pub audio_sample_rate: u32,
    pub stimulus_seconds: f64,
    pub last_dispatch_lateness_ms: Option<f64>,
    pub last_audio_lead_ms: Option<f64>,
    pub last_serial_write_ms: Option<f64>,
}

#[derive(Default)]
struct Control {
    active: AtomicBool,
    cancel: AtomicBool,
    resume: AtomicBool,
    queue_failed: AtomicBool,
    audio_failed: AtomicBool,
    audio_error: Mutex<Option<String>>,
    last_callback_ns: AtomicU64,
}

#[derive(Clone, Default)]
pub struct StimulationState {
    status: Arc<Mutex<StimulusStatus>>,
    control: Arc<Control>,
    visual: Arc<Mutex<Option<VisualSession>>>,
}

impl StimulationState {
    pub fn status(&self) -> StimulusStatus {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn is_active(&self) -> bool { self.control.active.load(Ordering::Acquire) }
    pub fn stop(&self) { self.control.cancel.store(true, Ordering::Release); }
    pub fn resume(&self) -> Result<()> {
        if self.status().phase != "waiting-block" { bail!("当前不在组间等待状态"); }
        self.control.resume.store(true, Ordering::Release); Ok(())
    }
    pub fn start(&self, app: AppHandle, config: StimulusConfig, target: StimulusRecordingTarget) -> Result<StimulusStatus> {
        self.start_inner(app, config, target, false)
    }
    fn start_inner(&self, app: AppHandle, config: StimulusConfig, target: StimulusRecordingTarget, test_only: bool) -> Result<StimulusStatus> {
        config.validate()?;
        if self.control.active.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { bail!("刺激正在运行，请先停止"); }
        self.control.cancel.store(false, Ordering::Relaxed);
        self.control.resume.store(false, Ordering::Relaxed);
        self.control.queue_failed.store(false, Ordering::Relaxed);
        self.control.audio_failed.store(false, Ordering::Relaxed);
        self.control.last_callback_ns.store(0, Ordering::Relaxed);
        *self.control.audio_error.lock().unwrap() = None;
        *self.status.lock().unwrap() = StimulusStatus { active: true, phase: "preparing".into(), message: "准备刺激；串口模式需等待 Arduino 重启并握手".into(), run_id: Uuid::new_v4().to_string(), total_blocks: config.blocks, total_trials: config.trials, marker_path: target.marker_path.clone(), ..Default::default() };
        let this = self.clone();
        let worker = std::thread::Builder::new().name("ifet-stimulus".into()).spawn(move || {
            let result = if config.modality == "light" { run_visual_experiment(&app, &this, config.clone(), target.clone(), test_only) }
                else { run_experiment(&app, &this, config.clone(), target.clone()) };
            if let Err(error) = result {
                this.stop();
                // The stream has been dropped. Do not invent an exact offset after
                // a hardware/recording failure; persist an explicitly uncertain abort.
                let timestamp = Utc::now().with_timezone(&Local).to_rfc3339_opts(SecondsFormat::Micros, false);
                let note = format!("FORCED_STOP_TIME_UNCERTAIN: {error:#}");
                let ble = app.state::<BleManagerState>();
                if let Ok(sample_count) = tauri::async_runtime::block_on(ble.append_stimulus_marker(&target,
                    &timestamp, &config.participant_id, "刺激异常中止（结束时刻未知）", &note, "forced_abort_uncertain")) {
                    let _ = app.emit("stimulus://event", UiEvent { timestamp, label: "刺激异常中止（结束时刻未知）".into(), note, sample_count, marker_path: target.marker_path });
                }
                let mut status = this.status.lock().unwrap();
                status.phase = "error".into(); status.message = format!("刺激已停止：{error:#}"); status.active = false;
            } else { this.status.lock().unwrap().active = false; }
            this.control.active.store(false, Ordering::Release);
            *this.visual.lock().unwrap() = None;
            if let Some(window) = app.get_webview_window("stimulus-light") { let _ = window.destroy(); }
            let _ = app.emit("stimulus://status", this.status());
        });
        if let Err(error) = worker { self.control.active.store(false, Ordering::Release); self.status.lock().unwrap().active = false; return Err(error.into()); }
        Ok(self.status())
    }

    pub fn timing_check(&self, app: AppHandle, output: PathBuf) -> Result<serde_json::Value> {
        if self.control.active.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { bail!("请先结束正在运行的刺激或自测"); }
        self.control.cancel.store(false, Ordering::Relaxed); self.control.resume.store(false, Ordering::Relaxed);
        self.control.queue_failed.store(false, Ordering::Relaxed); self.control.audio_failed.store(false, Ordering::Relaxed);
        self.control.last_callback_ns.store(0, Ordering::Relaxed);
        *self.control.audio_error.lock().unwrap() = None;
        *self.status.lock().unwrap() = StimulusStatus { active: true, phase: "benchmark".into(), message: "静音时序自测约 8 秒；不发 TTL、不修改 EEG 数据".into(), total_blocks: 1, total_trials: 40, ..Default::default() };
        let _ = app.emit("stimulus://status", self.status());
        let result = benchmark_impl(&output, 40, self.control.clone());
        self.control.active.store(false, Ordering::Release);
        {
            let mut s = self.status.lock().unwrap(); s.active = false;
            s.phase = if result.is_ok() { "complete" } else { "error" }.into();
            s.message = match &result { Ok(_) => "静音时序自测已保存；这不是声学/TTL 硬件校准".into(), Err(e) => e.to_string() };
            s.log_path = output.join("silent_timing_summary.json").to_string_lossy().to_string();
        }
        let _ = app.emit("stimulus://status", self.status());
        result.map(|report| serde_json::json!({ "output": output, "report": report }))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList { pub audio: Vec<String>, pub serial: Vec<String>, pub monitors: Vec<String> }

pub fn devices() -> Result<DeviceList> {
    let host = cpal::default_host();
    let mut audio = Vec::new();
    for (index, device) in host.output_devices()?.enumerate() {
        audio.push(format!("{}|{}", index, device));
    }
    let serial = serialport::available_ports()?.into_iter().map(|p| p.port_name).collect();
    Ok(DeviceList { audio, serial, monitors: Vec::new() })
}

#[derive(Clone)]
struct Wave { samples: Arc<Vec<[f32; 2]>>, rate: u32, sha256: String }

fn load_wave(config: &StimulusConfig) -> Result<Wave> {
    use sha2::{Digest, Sha256};
    if config.source == "test-tone" {
        let rate = 44100;
        let count = (config.duration_seconds * rate as f64).round() as usize;
        let ramp = (rate as f64 * 0.005) as usize;
        let samples: Vec<_> = (0..count).map(|i| {
            let envelope = (i as f32 / ramp as f32).min((count - 1 - i) as f32 / ramp as f32).min(1.0);
            let value = (std::f32::consts::TAU * 1000.0 * i as f32 / rate as f32).sin() * envelope * 0.25;
            [value, value]
        }).collect();
        return Ok(Wave { samples: Arc::new(samples), rate, sha256: "builtin-1000Hz-test-only-v1".into() });
    }
    let path = Path::new(&config.wav_path);
    if fs::metadata(path)?.len() > 100 * 1024 * 1024 { bail!("WAV 超过 100 MB 限制"); }
    let bytes = fs::read(path)?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let mut reader = hound::WavReader::new(std::io::Cursor::new(bytes)).context("仅支持未压缩 PCM/浮点 WAV")?;
    let spec = reader.spec();
    if ![1, 2].contains(&spec.channels) || !(8000..=192000).contains(&spec.sample_rate) { bail!("WAV 需为单/双声道，8–192 kHz"); }
    let duration = reader.duration() as f64 / spec.sample_rate as f64;
    if !(0.05..=120.0).contains(&duration) { bail!("WAV 时长需为 0.05–120 秒"); }
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<std::result::Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            if !(8..=32).contains(&spec.bits_per_sample) { bail!("不支持的 WAV 位深"); }
            let scale = 2_f32.powi(spec.bits_per_sample as i32 - 1);
            reader.samples::<i32>().map(|v| v.map(|x| x as f32 / scale)).collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    if raw.iter().any(|x| !x.is_finite() || x.abs() > 1.0) { bail!("WAV 存在非有限值或超过满量程，拒绝自动归一化改变原刺激"); }
    if !raw.iter().any(|x| x.abs() > 1e-6) { bail!("WAV 为静音，请检查原刺激导出"); }
    let samples = raw.chunks_exact(spec.channels as usize).map(|frame| [frame[0], *frame.get(1).unwrap_or(&frame[0])]).collect();
    Ok(Wave { samples: Arc::new(samples), rate: spec.sample_rate, sha256 })
}

#[derive(Clone, Copy)]
struct Clock { instant: Instant, epoch_ns: i64 }
impl Clock {
    fn new() -> Self { Self { instant: Instant::now(), epoch_ns: Utc::now().timestamp_nanos_opt().unwrap() } }
    fn ns(self) -> u64 { self.instant.elapsed().as_nanos().min(u64::MAX as u128) as u64 }
    fn timestamp(self, ns: u64) -> String {
        DateTime::<Utc>::from_timestamp_nanos(self.epoch_ns + ns as i64).with_timezone(&Local).to_rfc3339_opts(SecondsFormat::Micros, false)
    }
}

#[derive(Clone, Copy)]
struct TimedEdge { edge: Edge, callback_ns: u64, due_ns: u64, lead_ms: f64, buffer_frames: usize, timestamp_valid: bool }

fn select_device(id: &str) -> Result<cpal::Device> {
    let host = cpal::default_host();
    if id.is_empty() { return host.default_output_device().ok_or_else(|| anyhow!("没有音频输出设备")); }
    for (i, d) in host.output_devices()?.enumerate() {
        if format!("{}|{}", i, d) == id { return Ok(d); }
    }
    bail!("选定的音频设备已改变，请刷新设备列表后重新选择")
}

fn make_stream(config: &StimulusConfig, wave: &Wave, control: Arc<Control>, clock: Clock, tx: SyncSender<TimedEdge>) -> Result<(cpal::Stream, String)> {
    let device = select_device(&config.audio_device)?;
    let name = device.to_string();
    let mut formats: Vec<_> = device.supported_output_configs()?.filter(|s| s.channels() == 2 && s.min_sample_rate() <= wave.rate && s.max_sample_rate() >= wave.rate).collect();
    formats.sort_by_key(|f| if f.sample_format() == cpal::SampleFormat::F32 { 0 } else { 1 });
    let supported = formats.first().ok_or_else(|| anyhow!("该设备不支持双声道 {} Hz；为保护原刺激频谱，不做隐式重采样，请换设备或离线导出兼容 WAV", wave.rate))?.with_sample_rate(wave.rate);
    let stream_config = supported.config();
    // Driver default buffer: report measured buffer size, never claim an unachieved requested latency.
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build_stream::<f32>(&device, &stream_config, config, wave, control, clock, tx),
        cpal::SampleFormat::F64 => build_stream::<f64>(&device, &stream_config, config, wave, control, clock, tx),
        cpal::SampleFormat::I16 => build_stream::<i16>(&device, &stream_config, config, wave, control, clock, tx),
        cpal::SampleFormat::I32 => build_stream::<i32>(&device, &stream_config, config, wave, control, clock, tx),
        cpal::SampleFormat::U16 => build_stream::<u16>(&device, &stream_config, config, wave, control, clock, tx),
        _ => bail!("不支持该设备的音频样本格式"),
    }?;
    Ok((stream, name))
}

fn build_stream<T: cpal::SizedSample + cpal::FromSample<f32>>(device: &cpal::Device, stream_config: &cpal::StreamConfig,
    config: &StimulusConfig, wave: &Wave, control: Arc<Control>, clock: Clock, tx: SyncSender<TimedEdge>) -> Result<cpal::Stream> {
    let mut timeline = Timeline::new(config.blocks, config.trials,
        (config.cue_seconds * wave.rate as f64).round() as u64, wave.samples.len() as u64,
        (config.rest_seconds * wave.rate as f64).round() as u64, config.pause_between_blocks);
    let samples = wave.samples.clone(); let rate = wave.rate; let gain = config.volume;
    let error_control = control.clone();
    let mut clock_mapping: Option<(cpal::StreamInstant, u64)> = None;
    let stream = device.build_output_stream(*stream_config, move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
        let callback_ns = clock.ns();
        control.last_callback_ns.store(callback_ns, Ordering::Relaxed);
        let timestamp = info.timestamp();
        let lead = timestamp.playback.checked_duration_since(timestamp.callback);
        let timestamp_valid = lead.map(|d| d <= Duration::from_secs(2)).unwrap_or(false);
        let lead_ns = lead.unwrap_or_default().as_nanos().min(2_000_000_000) as u64;
        // One clock-domain anchor per uninterrupted stream; do not inject callback
        // scheduling jitter into every onset/offset timestamp.
        let mapping = clock_mapping.get_or_insert((timestamp.callback, callback_ns));
        let playback_ns = timestamp.playback.checked_duration_since(mapping.0)
            .map(|delta| mapping.1.saturating_add(delta.as_nanos() as u64)).unwrap_or(callback_ns + lead_ns);
        let frames = data.len() / 2;
        for (index, output) in data.chunks_exact_mut(2).enumerate() {
            let due_ns = playback_ns + index as u64 * 1_000_000_000 / rate as u64;
            let source = timeline.next(&control.cancel, &control.resume, |edge| {
                let message = TimedEdge { edge, callback_ns, due_ns, lead_ms: lead_ns as f64 / 1e6, buffer_frames: frames, timestamp_valid };
                if tx.try_send(message).is_err() { control.queue_failed.store(true, Ordering::Relaxed); control.cancel.store(true, Ordering::Relaxed); }
            });
            let pair = source.map(|i| samples[i]).unwrap_or([0.0, 0.0]);
            output[0] = T::from_sample(pair[0] * gain); output[1] = T::from_sample(pair[1] * gain);
        }
    }, move |error| {
        *error_control.audio_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("{error:?}"));
        error_control.audio_failed.store(true, Ordering::Relaxed);
        error_control.cancel.store(true, Ordering::Relaxed);
    }, None)?;
    Ok(stream)
}

fn wait_until(clock: Clock, ns: u64) {
    loop {
        let now = clock.ns();
        if now >= ns { return; }
        // No full-period busy-wait: low CPU usage between events. Actual overshoot is measured.
        std::thread::sleep(Duration::from_nanos((ns - now).min(2_000_000)));
    }
}

// Request 1 ms Windows scheduling only while an experiment/self-test is active;
// always release the request. This is not a real-time guarantee: overshoot is logged.
struct TimerResolution;
#[cfg(windows)]
#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(period: u32) -> u32;
    fn timeEndPeriod(period: u32) -> u32;
}
impl TimerResolution {
    fn acquire() -> Result<Self> {
        #[cfg(windows)]
        if unsafe { timeBeginPeriod(1) } != 0 { bail!("无法请求 Windows 1 ms 定时精度"); }
        Ok(Self)
    }
}
impl Drop for TimerResolution {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe { timeEndPeriod(1); }
    }
}

fn open_serial(config: &StimulusConfig, control: &Control) -> Result<Option<Box<dyn serialport::SerialPort>>> {
    if !config.serial_enabled { return Ok(None); }
    let mut port = serialport::new(&config.serial_port, 115200).dtr_on_open(true).timeout(Duration::from_millis(30)).open().context("打开 Arduino 串口失败")?;
    let reset = Instant::now();
    while reset.elapsed() < Duration::from_millis(2500) {
        if control.cancel.load(Ordering::Relaxed) { bail!("准备已取消"); }
        std::thread::sleep(Duration::from_millis(10));
    }
    port.clear(serialport::ClearBuffer::All)?;
    port.write_all(b"P")?; port.flush()?;
    let deadline = Instant::now(); let mut bytes = [0u8; 64];
    while deadline.elapsed() < Duration::from_secs(1) {
        if control.cancel.load(Ordering::Relaxed) { bail!("准备已取消"); }
        match port.read(&mut bytes) {
            Ok(n) if bytes[..n].contains(&b'A') => return Ok(Some(port)),
            Ok(_) => {},
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {},
            Err(e) => return Err(e.into()),
        }
    }
    bail!("Arduino P→A 握手失败；未发送 T，也未开始播放。请确认固件与串口")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiEvent { timestamp: String, label: String, note: String, sample_count: u64, marker_path: String }

fn csv(value: &str) -> String { format!("\"{}\"", value.replace('"', "\"\"")) }
const EVENT_HEADER: &str = "runId,block,trial,event,time,callbackTime,workerTime,dispatchTime,callbackToWorkerMs,audioLeadMs,dispatchLatenessMs,markerWriteMs,serialWriteMs,serialCommand,serialError,interrupted,audioBufferFrames,audioSampleRate,timestampKind,markerPath,audioFrame";

fn run_experiment(app: &AppHandle, state: &StimulationState, config: StimulusConfig, target: StimulusRecordingTarget) -> Result<()> {
    let _timer = TimerResolution::acquire()?;
    let wave = load_wave(&config)?;
    let mut serial = open_serial(&config, &state.control)?;
    if state.control.cancel.load(Ordering::Relaxed) { bail!("准备已取消"); }
    let ble = app.state::<BleManagerState>();
    if !ble.stimulus_stream_recent() { bail!("没有最近 2.5 秒的有效 EEG；请确认头带正在传输信号"); }
    let current = tauri::async_runtime::block_on(ble.stimulus_recording_target())?;
    if current.marker_path != target.marker_path { bail!("记录文件已更换"); }
    let run_id = state.status().run_id;
    let log_path = PathBuf::from(&target.recording_path).with_file_name(format!("stimulus_{}.csv", run_id));
    let mut log = BufWriter::new(OpenOptions::new().write(true).create_new(true).open(&log_path)?);
    writeln!(log, "{EVENT_HEADER}")?; log.flush()?;
    let clock = Clock::new();
    let (tx, rx) = mpsc::sync_channel(128);
    let (stream, device_name) = make_stream(&config, &wave, state.control.clone(), clock, tx)?;
    fs::write(log_path.with_extension("json"), serde_json::to_vec_pretty(&serde_json::json!({
        "schema": "ifet-stimulus/v1", "runId": run_id, "config": config, "wavSha256": wave.sha256,
        "waveFrames": wave.samples.len(), "audioSampleRate": wave.rate, "audioDevice": device_name,
        "eegRecording": target.recording_path, "markers": target.marker_path,
        "eventTimestamp": "predicted DAC PCM file boundary including any leading/trailing silence; audio clock anchored once to host monotonic/UTC; NOT measured acoustic onset",
        "ttlProtocol": "115200 8N1; P/A handshake; T identical pulse at selected onset/offset; actual pin timing unmeasured",
        "eegClock": "BLE arrival anchored host sample clock; no shared hardware clock; EEG alignment contains unmeasured transport delay",
        "sourceWaveform": if config.source == "wav" { "user supplied WAV, unmodified except gain" } else { "1000 Hz TEST tone, NOT Don chirp" }
    }))?)?;
    {
        let mut s = state.status.lock().unwrap(); s.phase = "cue".into(); s.message = "实验已启动；声音起止自动保存到 EEG 标记文件".into();
        s.log_path = log_path.to_string_lossy().to_string(); s.audio_device = device_name;
        s.audio_sample_rate = wave.rate; s.stimulus_seconds = wave.samples.len() as f64 / wave.rate as f64;
    }
    let _ = app.emit("stimulus://status", state.status());
    stream.play()?;
    let mut cancellation_reason = String::new(); let mut termination_deadline = None;
    loop {
        if state.control.queue_failed.load(Ordering::Relaxed) { bail!("音频事件队列溢出，立即停止；本次时序不可用于分析"); }
        if state.control.audio_failed.load(Ordering::Relaxed) { bail!("音频驱动报告错误，立即停止；实际结束时刻未知：{:?}", state.control.audio_error.lock().unwrap().as_deref()); }
        if clock.ns().saturating_sub(state.control.last_callback_ns.load(Ordering::Relaxed)) > 3_000_000_000 { bail!("音频回调停止，实际结束时刻未知"); }
        if !ble.stimulus_stream_recent() && !state.control.cancel.load(Ordering::Relaxed) {
            cancellation_reason = "EEG 连续 2.5 秒无有效数据，自动中止".into(); state.stop();
        }
        if state.control.cancel.load(Ordering::Relaxed) && termination_deadline.is_none() { termination_deadline = Some(Instant::now()); }
        if termination_deadline.map(|t: Instant| t.elapsed() > Duration::from_secs(3)).unwrap_or(false) { bail!("停止超时；音频流已强制关闭，实际结束时刻未知"); }
        let message = match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(v) => v,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Long rests / block waits legitimately have no edges; callback failure is reported separately.
                continue;
            },
            Err(_) => bail!("音频线程中断"),
        };
        let worker_ns = clock.ns();
        let edge = message.edge;
        let timestamp = clock.timestamp(message.due_ns);
        let note = format!("run={} block={} trial={} {}; {}; {}", run_id, edge.block, edge.trial,
            if edge.interrupted { "interrupted" } else { "normal" },
            if message.timestamp_valid { "predicted_DAC" } else { "callback_fallback_UNCERTAIN" }, cancellation_reason);
        // Persist the captured sample-clock time before waiting for the serial deadline.
        let marker_start = Instant::now();
        let sample_count = tauri::async_runtime::block_on(ble.append_stimulus_marker(&target, &timestamp,
            &config.participant_id, edge.kind.label(), &note, edge.kind.key()))?;
        let marker_ms = marker_start.elapsed().as_secs_f64() * 1000.0;
        wait_until(clock, message.due_ns);
        let dispatch_ns = clock.ns();
        let mut serial_ms = None; let mut serial_error = String::new(); let mut serial_command = "";
        let trigger = edge.kind == EdgeKind::On || (edge.kind == EdgeKind::Off && config.serial_on_offset);
        if trigger {
            if let Some(port) = serial.as_mut() {
                serial_command = "T";
                let start = Instant::now();
                if let Err(error) = port.write_all(b"T").and_then(|_| port.flush()) { serial_error = error.to_string(); state.stop(); cancellation_reason = "串口触发失败，实验自动中止".into(); }
                serial_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        let lateness_ms = (dispatch_ns as i128 - message.due_ns as i128) as f64 / 1e6;
        writeln!(log, "{},{},{},{},{},{},{},{},{:.6},{:.6},{:.6},{:.6},{},{},{},{},{},{},{},{},{}",
            csv(&run_id), edge.block, edge.trial, edge.kind.key(), timestamp, clock.timestamp(message.callback_ns), clock.timestamp(worker_ns), clock.timestamp(dispatch_ns),
            (worker_ns - message.callback_ns) as f64 / 1e6, message.lead_ms, lateness_ms, marker_ms,
            serial_ms.map(|v| format!("{v:.6}")).unwrap_or_default(), serial_command, csv(&serial_error), edge.interrupted,
            message.buffer_frames, wave.rate, if message.timestamp_valid { "predicted_DAC" } else { "callback_fallback_UNCERTAIN" }, csv(&target.marker_path), edge.output_frame)?;
        log.flush()?;
        let _ = app.emit("stimulus://event", UiEvent { timestamp, label: edge.kind.label().into(), note, sample_count, marker_path: target.marker_path.clone() });
        {
            let mut s = state.status.lock().unwrap(); s.block = edge.block; s.trial = edge.trial; s.marker_count += 1;
            s.last_dispatch_lateness_ms = Some(lateness_ms); s.last_audio_lead_ms = Some(message.lead_ms); s.last_serial_write_ms = serial_ms;
            s.phase = match edge.kind { EdgeKind::Cue => "cue", EdgeKind::On => "playing", EdgeKind::Off => "rest", EdgeKind::BlockEnd if edge.block < config.blocks && config.pause_between_blocks => "waiting-block", EdgeKind::BlockEnd => "rest", EdgeKind::Complete => "complete", EdgeKind::Aborted => "aborted" }.into();
            s.message = if cancellation_reason.is_empty() { edge.kind.label().into() } else { cancellation_reason.clone() };
            if !message.timestamp_valid { s.message += "；驱动时间戳不可用，本次标记精度未知"; }
        }
        let _ = app.emit("stimulus://status", state.status());
        if matches!(edge.kind, EdgeKind::Complete | EdgeKind::Aborted) { break; }
    }
    drop(stream); log.flush()?; Ok(())
}

/// Silent native-output measurement. No serial trigger, no BLE data and no acoustic latency claim.
pub fn benchmark(output: &Path, trials: u32) -> Result<serde_json::Value> {
    benchmark_impl(output, trials, Arc::new(Control::default()))
}

fn benchmark_impl(output: &Path, trials: u32, control: Arc<Control>) -> Result<serde_json::Value> {
    let _timer = TimerResolution::acquire()?;
    if !(5..=200).contains(&trials) { bail!("benchmark trials must be 5–200"); }
    let config = StimulusConfig { modality: "sound".into(), light_brightness: 0.25, light_fullscreen: false, light_monitor: "".into(), source: "test-tone".into(), wav_path: "".into(), audio_device: "".into(), serial_port: "".into(), serial_enabled: false,
        serial_on_offset: false, duration_seconds: 0.08, cue_seconds: 0.05, rest_seconds: 0.07, trials, blocks: 1, pause_between_blocks: false, volume: 0.0, participant_id: "SILENT_TIMING_BENCHMARK".into() };
    let wave = load_wave(&config)?; let clock = Clock::new();
    let (tx, rx): (SyncSender<TimedEdge>, Receiver<TimedEdge>) = mpsc::sync_channel(128);
    let (stream, device) = make_stream(&config, &wave, control.clone(), clock, tx)?;
    fs::create_dir_all(output)?;
    let mut log = BufWriter::new(File::create(output.join("silent_timing_edges.csv"))?);
    let mut marker_probe = BufWriter::new(File::create(output.join("silent_marker_write_probe.csv"))?);
    writeln!(marker_probe, "predictedTime,event,audioFrame")?;
    writeln!(log, "event,callbackToWorkerMs,audioLeadMs,dispatchLatenessMs,markerWriteMs,bufferFrames,timestampValid")?;
    let mut queue = Vec::new(); let mut lead = Vec::new(); let mut late = Vec::new(); let mut writes = Vec::new(); let mut buffer = Vec::new(); let mut invalid = 0;
    stream.play()?;
    loop {
        let e = rx.recv_timeout(Duration::from_secs(3)).context("audio benchmark callback timeout")?;
        let worker = clock.ns();
        let start = Instant::now();
        writeln!(marker_probe, "{},{},{}", clock.timestamp(e.due_ns), e.edge.kind.key(), e.edge.output_frame)?;
        marker_probe.flush()?;
        let w = start.elapsed().as_secs_f64() * 1000.0;
        wait_until(clock, e.due_ns);
        let dispatch = clock.ns();
        let q = (worker - e.callback_ns) as f64 / 1e6; let l = (dispatch as i128 - e.due_ns as i128) as f64 / 1e6;
        writeln!(log, "{},{:.6},{:.6},{:.6},{:.6},{},{:?}", e.edge.kind.key(), q, e.lead_ms, l, w, e.buffer_frames, e.timestamp_valid)?;
        log.flush()?;
        if matches!(e.edge.kind, EdgeKind::On | EdgeKind::Off) { queue.push(q); lead.push(e.lead_ms); late.push(l); writes.push(w); buffer.push(e.buffer_frames); if !e.timestamp_valid { invalid += 1; } }
        if e.edge.kind == EdgeKind::Aborted { bail!("静音自测已取消；音频驱动错误={:?}，队列溢出={}", control.audio_error.lock().unwrap().as_deref(), control.queue_failed.load(Ordering::Relaxed)); }
        if e.edge.kind == EdgeKind::Complete { break; }
    }
    drop(stream);
    let stats = |mut values: Vec<f64>| { values.sort_by(f64::total_cmp); serde_json::json!({"min": values[0], "p50": values[values.len()/2], "p95": values[((values.len() as f64 * 0.95).ceil() as usize - 1).min(values.len()-1)], "max": values[values.len()-1]}) };
    let report = serde_json::json!({"schema": "ifet-silent-audio-timing/v1", "platform": std::env::consts::OS, "device": device, "sampleRate": wave.rate, "trials": trials, "soundEdges": queue.len(), "invalidTimestamps": invalid,
        "callbackToWorkerMs": stats(queue), "reportedAudioLeadMs": stats(lead), "scheduledDispatchLatenessMs": stats(late), "diskFlushMs": stats(writes), "bufferFrames": buffer,
        "acousticOnsetMeasured": false, "ttlPinMeasured": false, "bleAlignmentMeasured": false,
        "scope": "Silent output on current computer; software scheduling and driver estimates only. No EEG load or actual acoustic/TTL loopback."});
    fs::write(output.join("silent_timing_summary.json"), serde_json::to_vec_pretty(&report)?)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> StimulusConfig { StimulusConfig { modality:"sound".into(), light_brightness:0.25, light_fullscreen:false, light_monitor:"".into(), source:"test-tone".into(), wav_path:"".into(), audio_device:"".into(), serial_port:"".into(), serial_enabled:false, serial_on_offset:true, duration_seconds:5.0, cue_seconds:1.0, rest_seconds:2.0, trials:5, blocks:3, pause_between_blocks:true, volume:0.1, participant_id:"".into() } }
    #[test] fn missing_original_wave_is_not_silently_replaced() { let mut c = config(); c.source="wav".into(); assert!(c.validate().is_err()); }
    #[test] fn parameters_bound_memory_and_output_gain() { let mut c=config(); assert!(c.validate().is_ok()); c.volume=f32::NAN; assert!(c.validate().is_err()); c.volume=1.0; assert!(c.validate().is_err()); c.volume=0.1; c.blocks=100;c.trials=100; assert!(c.validate().is_err()); }
    #[test] fn generated_tone_has_exact_length_and_soft_edges() { let c=config(); let w=load_wave(&c).unwrap(); assert_eq!(w.samples.len(),220500); assert_eq!(w.samples[0],[0.0,0.0]); assert_eq!(w.samples.last().unwrap(),&[0.0,0.0]); }
    #[test] fn timestamp_keeps_microseconds_and_timezone() { let c=Clock { instant:Instant::now(),epoch_ns:1_700_000_000_000_000_000 }; let value=c.timestamp(123_456_789); assert!(value.contains(".123456")); }
}
