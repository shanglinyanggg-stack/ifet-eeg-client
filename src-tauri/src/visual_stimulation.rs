//! Screen events are render-request timestamps, not measured optical onsets.
use super::*;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[derive(Clone)]
pub(super) struct VisualSession {
    clock: Clock,
    config: StimulusConfig,
    run_id: String,
    tx: SyncSender<VisualMessage>,
}
enum VisualMessage { Ready, Rendered(VisualRendered) }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualRendered {
    run_id: String,
    sequence: u32,
    captured_time_ms: f64,
    frame_interval_ms: f64,
    clock_uncertainty_ms: f64,
}

impl StimulationState {
    pub fn visual_clock(&self) -> Result<serde_json::Value> {
        let visual = self.visual.lock().unwrap();
        let s = visual.as_ref().ok_or_else(|| anyhow!("没有正在准备的光刺激窗口"))?;
        Ok(serde_json::json!({"runId": s.run_id, "config": s.config, "hostTimeMs": s.clock.ns() as f64 / 1e6}))
    }
    pub fn visual_ready(&self, run_id: &str) -> Result<()> {
        let visual = self.visual.lock().unwrap();
        let s = visual.as_ref().ok_or_else(|| anyhow!("光刺激已结束"))?;
        if s.run_id != run_id { bail!("光刺激运行标识已改变"); }
        s.tx.try_send(VisualMessage::Ready).map_err(|_| anyhow!("光刺激队列不可用"))
    }
    pub fn visual_rendered(&self, value: VisualRendered) -> Result<()> {
        let visual = self.visual.lock().unwrap();
        let s = visual.as_ref().ok_or_else(|| anyhow!("光刺激已结束"))?;
        if s.run_id != value.run_id { bail!("光刺激运行标识已改变"); }
        validate_visual_time(&value, s.clock.ns() as f64 / 1e6)?;
        s.tx.try_send(VisualMessage::Rendered(value)).map_err(|_| {
            self.stop(); anyhow!("光刺激事件队列不可用，实验已停止")
        })
    }
    pub fn visual_timing_check(&self, app: AppHandle) -> Result<StimulusStatus> {
        let directory = app.path().app_local_data_dir()?.join("visual_timing_checks").join(Uuid::new_v4().to_string());
        fs::create_dir_all(&directory)?;
        let config = StimulusConfig { modality: "light".into(), light_brightness: 0.0, light_fullscreen: false, light_monitor: "".into(),
            source: "test-tone".into(), wav_path: "".into(), audio_device: "".into(), serial_port: "".into(), serial_enabled: false,
            serial_on_offset: false, duration_seconds: 0.2, cue_seconds: 0.1, rest_seconds: 0.1, trials: 20, blocks: 1,
            pause_between_blocks: false, volume: 0.0, participant_id: "SCREEN_TIMING_CHECK_NO_LIGHT_NO_TTL".into() };
        self.start_inner(app, config, StimulusRecordingTarget { recording_path: directory.join("screen_test.csv").to_string_lossy().into(), marker_path: "".into() }, true)
    }
}

fn validate_visual_time(v: &VisualRendered, now_ms: f64) -> Result<()> {
    if !v.captured_time_ms.is_finite() || v.captured_time_ms < 0.0 || v.captured_time_ms > now_ms + 100.0 || now_ms - v.captured_time_ms > 2000.0 {
        bail!("屏幕事件时间超出允许范围");
    }
    if !v.clock_uncertainty_ms.is_finite() || !(0.0..=10.0).contains(&v.clock_uncertainty_ms) {
        bail!("屏幕与主机时钟同步误差过大");
    }
    if !v.frame_interval_ms.is_finite() || !(0.0..=1000.0).contains(&v.frame_interval_ms) { bail!("无效的屏幕刷新间隔"); }
    Ok(())
}

pub fn monitor_names(app: &AppHandle) -> Result<Vec<String>> {
    let window = app.get_webview_window("main").ok_or_else(|| anyhow!("主窗口不可用"))?;
    Ok(window.available_monitors()?.iter().enumerate().map(|(i,m)| format!("{}|{} {}×{}", i, m.name().map(String::as_str).unwrap_or("显示器"), m.size().width, m.size().height)).collect())
}

fn create_visual_window(app: &AppHandle, config: &StimulusConfig) -> Result<()> {
    let main = app.get_webview_window("main").ok_or_else(|| anyhow!("主窗口不可用"))?;
    let monitors = main.available_monitors()?;
    let selected = if config.light_monitor.is_empty() { main.current_monitor()? }
        else { monitors.iter().enumerate().find(|(i,m)| format!("{}|{} {}×{}", i, m.name().map(String::as_str).unwrap_or("显示器"), m.size().width, m.size().height) == config.light_monitor).map(|(_,m)| m.clone()) };
    let monitor = selected.ok_or_else(|| anyhow!("刺激显示器已改变，请刷新设备列表"))?;
    let scale = monitor.scale_factor();
    let (width,height) = (monitor.size().width as f64 / scale, monitor.size().height as f64 / scale);
    let (x,y) = (monitor.position().x as f64 / scale, monitor.position().y as f64 / scale);
    let mut builder = WebviewWindowBuilder::new(app, "stimulus-light", WebviewUrl::App("index.html?stimulus=light".into()))
        .title("iFET 屏幕光刺激 · Esc 停止").inner_size(480.0,480.0).resizable(false).always_on_top(true)
        .position(x + (width - 480.0)/2.0, y + (height - 480.0)/2.0);
    if config.light_fullscreen { builder = builder.position(x,y).inner_size(width,height).fullscreen(true); }
    builder.build()?; Ok(())
}

struct VisualLog<'a> {
    app: &'a AppHandle,
    state: &'a StimulationState,
    config: &'a StimulusConfig,
    target: &'a StimulusRecordingTarget,
    clock: Clock,
    rx: Receiver<VisualMessage>,
    writer: BufWriter<File>,
    serial: Option<Box<dyn serialport::SerialPort>>,
    sequence: u32,
    test_only: bool,
    schedule_late: Vec<f64>,
    ipc_delay: Vec<f64>,
    frame_intervals: Vec<f64>,
    clock_uncertainty: Vec<f64>,
}
impl VisualLog<'_> {
    fn wait(&self, deadline: u64) -> Result<bool> {
        loop {
            if self.state.control.cancel.load(Ordering::Relaxed) { return Ok(false); }
            if !self.test_only && !self.app.state::<BleManagerState>().stimulus_stream_recent() { self.state.stop(); return Ok(false); }
            if let Some(window) = self.app.get_webview_window("stimulus-light") {
                if window.is_minimized().unwrap_or(false) { bail!("光刺激窗口被最小化，发光结束时刻无法确认"); }
            } else { bail!("光刺激窗口已关闭"); }
            let now = self.clock.ns(); if now >= deadline { return Ok(true); }
            let remaining=deadline-now;
            std::thread::sleep(Duration::from_nanos(remaining.min(if remaining>20_000_000 {10_000_000} else {1_000_000})));
        }
    }
    fn edge(&mut self, kind: &str, label: &str, brightness: f32, block: u32, trial: u32, due: u64, interrupted: bool) -> Result<u64> {
        self.sequence += 1;
        self.app.emit_to("stimulus-light", "stimulus://light-frame", serde_json::json!({
            "runId": self.state.status().run_id, "sequence": self.sequence, "kind": kind, "label": label,
            "brightness": brightness, "scheduledTimeMs": due as f64/1e6, "block": block, "trial": trial
        }))?;
        let deadline = Instant::now();
        let ack = loop {
            if deadline.elapsed() > Duration::from_secs(2) { bail!("屏幕绘制确认超时；光刺激已停止，实际结束时刻未知"); }
            match self.rx.recv_timeout(Duration::from_millis(20)) {
                Ok(VisualMessage::Rendered(v)) if v.sequence == self.sequence => break v,
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {},
                Err(_) => bail!("光刺激窗口通讯中断"),
            }
        };
        let received = self.clock.ns();
        let captured = (ack.captured_time_ms * 1e6).round() as u64;
        let dispatch = self.clock.ns();
        let mut serial_ms = None;
        if kind == "light_on" || (kind == "light_off" && self.config.serial_on_offset) {
            if let Some(port) = self.serial.as_mut() {
                let start=Instant::now(); port.write_all(b"T")?; port.flush()?;
                serial_ms=Some(start.elapsed().as_secs_f64()*1000.0);
            }
        }
        let timestamp = self.clock.timestamp(captured);
        let note = format!("run={} block={} trial={} {}; screen_render_request; clock_uncertainty_ms={:.3}; physical_light_unmeasured",
            self.state.status().run_id, block, trial, if interrupted { "interrupted" } else { "normal" }, ack.clock_uncertainty_ms);
        let marker_start = Instant::now();
        if !self.test_only {
            let samples = tauri::async_runtime::block_on(self.app.state::<BleManagerState>().append_stimulus_marker(self.target,
                &timestamp, &self.config.participant_id, label, &note, kind))?;
            let _=self.app.emit("stimulus://event", UiEvent { timestamp:timestamp.clone(),label:label.into(),note,sample_count:samples,marker_path:self.target.marker_path.clone() });
        }
        let marker_ms=marker_start.elapsed().as_secs_f64()*1000.0;
        let late=(captured as i128-due as i128) as f64/1e6;
        let ipc=(received as i128-captured as i128) as f64/1e6;
        writeln!(self.writer,"{},{},{},{},{},{},{},{:.6},{:.6},{:.6},{:.6},{:.6},{},{},{}",self.sequence,block,trial,kind,timestamp,
            self.clock.timestamp(due),self.clock.timestamp(dispatch),late,ipc,ack.frame_interval_ms,ack.clock_uncertainty_ms,marker_ms,
            serial_ms.map(|v|format!("{v:.6}")).unwrap_or_default(),interrupted,brightness)?;
        self.writer.flush()?;
        if kind=="light_on" || kind=="light_off" {
            self.schedule_late.push(late);self.ipc_delay.push(ipc);self.frame_intervals.push(ack.frame_interval_ms);self.clock_uncertainty.push(ack.clock_uncertainty_ms);
        }
        let mut s=self.state.status.lock().unwrap();s.block=block;s.trial=trial;if !self.test_only { s.marker_count+=1; }
        s.last_dispatch_lateness_ms=Some((dispatch as i128-captured as i128) as f64/1e6);s.last_audio_lead_ms=None;s.last_serial_write_ms=serial_ms;
        s.phase=match kind {"light_on"=>"playing","light_off"=>"rest","cue"=>"cue","complete"=>"complete","aborted"=>"aborted",_=>"rest"}.into();
        s.message=if self.test_only { format!("屏幕时序自测：{label}（全黑、不发 TTL、不写 EEG 标记）") } else { label.into() };
        drop(s);let _=self.app.emit("stimulus://status",self.state.status()); Ok(captured)
    }
}

pub(super) fn run_visual_experiment(app:&AppHandle,state:&StimulationState,config:StimulusConfig,target:StimulusRecordingTarget,test_only:bool)->Result<()> {
    let _timer=TimerResolution::acquire()?;
    let serial=open_serial(&config,&state.control)?;
    let clock=Clock::new();let (tx,rx)=mpsc::sync_channel(64);
    let run_id=state.status().run_id;
    *state.visual.lock().unwrap()=Some(VisualSession { clock,config:config.clone(),run_id:run_id.clone(),tx });
    let path=PathBuf::from(&target.recording_path).with_file_name(format!("stimulus_light_{run_id}.csv"));
    let mut writer=BufWriter::new(OpenOptions::new().write(true).create_new(true).open(&path)?);
    writeln!(writer,"sequence,block,trial,event,time,scheduledTime,dispatchTime,renderScheduleLatenessMs,renderToBackendMs,frameIntervalMs,clockUncertaintyMs,markerWriteMs,serialWriteMs,interrupted,brightness")?;writer.flush()?;
    fs::write(path.with_extension("json"),serde_json::to_vec_pretty(&serde_json::json!({"schema":"ifet-screen-stimulus/v1","runId":run_id,"config":config,"testOnly":test_only,
        "markers":target.marker_path,"timestampKind":"screen_render_request; before compositor/scanout; actual optical onset unmeasured",
        "ttlProtocol":"T at received render acknowledgement; actual pin latency unmeasured"}))?)?;
    state.status.lock().unwrap().log_path=path.to_string_lossy().into();
    create_visual_window(app,&config)?;
    let ready_deadline=Instant::now();
    loop {
        if state.control.cancel.load(Ordering::Relaxed) { bail!("光刺激准备已取消"); }
        if ready_deadline.elapsed()>Duration::from_secs(10) { bail!("屏幕刺激窗口准备超时"); }
        if let Ok(VisualMessage::Ready)=rx.recv_timeout(Duration::from_millis(20)) { break; }
    }
    let mut log=VisualLog {app,state,config:&config,target:&target,clock,rx,writer,serial,sequence:0,test_only,schedule_late:Vec::new(),ipc_delay:Vec::new(),frame_intervals:Vec::new(),clock_uncertainty:Vec::new()};
    let (mut is_on,mut block,mut trial)=(false,1,1);let mut aborted=false;
    'experiment: for b in 1..=config.blocks {
        block=b;
        for t in 1..=config.trials {
            trial=t;
            if state.control.cancel.load(Ordering::Relaxed) { aborted=true;break 'experiment; }
            let cue=log.edge("cue","光刺激提示",0.0,b,t,clock.ns(),false)?;
            if !log.wait(cue+(config.cue_seconds*1e9) as u64)? { aborted=true;break 'experiment; }
            let on=log.edge("light_on","光刺激开始",config.light_brightness,b,t,cue+(config.cue_seconds*1e9) as u64,false)?;is_on=true;
            if !log.wait(on+(config.duration_seconds*1e9) as u64)? { aborted=true;break 'experiment; }
            let off=log.edge("light_off","光刺激结束",0.0,b,t,on+(config.duration_seconds*1e9) as u64,false)?;is_on=false;
            if !log.wait(off+(config.rest_seconds*1e9) as u64)? { aborted=true;break 'experiment; }
        }
        log.edge("block_end","光刺激组结束",0.0,b,trial,clock.ns(),false)?;
        if b<config.blocks && config.pause_between_blocks {
            {let mut s=state.status.lock().unwrap();s.phase="waiting-block".into();s.message="等待继续下一组（光刺激窗口可按空格）".into();}
            let _=app.emit("stimulus://status",state.status());
            while !state.control.resume.swap(false,Ordering::Relaxed) {
                if !log.wait(clock.ns()+20_000_000)? { aborted=true;break 'experiment; }
            }
        }
    }
    if is_on { log.edge("light_off","光刺激结束（中止）",0.0,block,trial,clock.ns(),true)?; }
    log.edge(if aborted {"aborted"} else {"complete"},if aborted {"光刺激实验中止"} else {"光刺激实验完成"},0.0,block,trial,clock.ns(),aborted)?;
    let stats=|mut v:Vec<f64>| { if v.is_empty(){return serde_json::Value::Null;}v.sort_by(f64::total_cmp);serde_json::json!({"p50":v[v.len()/2],"p95":v[((v.len() as f64*0.95).ceil() as usize-1).min(v.len()-1)],"max":v[v.len()-1]}) };
    let summary=path.with_file_name(format!("stimulus_light_{run_id}_summary.json"));
    fs::write(&summary,serde_json::to_vec_pretty(&serde_json::json!({"schema":"ifet-screen-timing/v1","testOnly":test_only,"aborted":aborted,"edges":log.schedule_late.len(),
        "renderScheduleLatenessMs":stats(log.schedule_late),"renderToBackendMs":stats(log.ipc_delay),"frameIntervalMs":stats(log.frame_intervals),"clockUncertaintyMs":stats(log.clock_uncertainty),
        "opticalOnsetMeasured":false,"ttlPinMeasured":false,"bleAlignmentMeasured":false}))?)?;
    if test_only { let mut s=state.status.lock().unwrap();s.log_path=summary.to_string_lossy().into();s.message="屏幕时序自测已保存；实际发光时刻需光电传感器校准".into(); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn screen_clock_rejects_stale_future_and_unreliable_acknowledgements() {
        let mut v=VisualRendered {run_id:"test".into(),sequence:1,captured_time_ms:1000.0,frame_interval_ms:16.67,clock_uncertainty_ms:0.5};
        assert!(validate_visual_time(&v,1001.0).is_ok());
        assert!(validate_visual_time(&v,4000.0).is_err());
        assert!(validate_visual_time(&v,100.0).is_err());
        v.clock_uncertainty_ms=11.0;assert!(validate_visual_time(&v,1001.0).is_err());
        v.clock_uncertainty_ms=f64::NAN;assert!(validate_visual_time(&v,1001.0).is_err());
    }
}
