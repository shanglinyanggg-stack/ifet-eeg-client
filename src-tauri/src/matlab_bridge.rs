//! Loopback-only stimulus telemetry. No audio, screen or serial stimulus generation.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_MESSAGE: usize = 32_768;
const MAX_RECENT_ACKS: usize = 512;
type MarkerWriter = Arc<dyn Fn(f64, &str, &str) -> Result<Value, String> + Send + Sync>;

#[derive(Clone, Debug, Default, Serialize)]
pub struct BridgeStatus {
    pub running: bool,
    pub connected: bool,
    pub port: u16,
    pub event_count: u64,
    pub active_stimuli: usize,
    pub last_event: String,
    pub last_receive_delay_ms: Option<f64>,
    pub last_durable_delay_ms: Option<f64>,
    pub clock_uncertainty_ms: Option<f64>,
    pub event_path: String,
    pub csv_path: String,
    pub connection_path: String,
    pub last_error: String,
    pub alignment_pending: bool,
    pub alignment_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StimulusEvent {
    pub event_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub stimulus_id: String,
    pub modality: String,
    pub edge: String,
    pub source_time: f64,
    pub clock_offset_s: f64,
    pub sync_uncertainty_s: f64,
    pub clock_id: String,
    pub timestamp_source: String,
    #[serde(default)]
    pub metadata: Value,
}

struct Worker {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
pub struct MatlabBridgeState {
    worker: Mutex<Option<Worker>>,
    status: Arc<Mutex<BridgeStatus>>,
}

impl MatlabBridgeState {
    pub fn status(&self) -> BridgeStatus { self.status.lock().unwrap().clone() }
    pub fn alignment_status(&self, pending: bool, path: String, error: String) {
        let mut status=self.status.lock().unwrap();status.alignment_pending=pending;
        status.alignment_path=path;if !error.is_empty(){status.last_error=error;}
    }

    pub fn start(&self, port: u16, recording: PathBuf, connection_path: PathBuf,
                 marker: MarkerWriter) -> Result<BridgeStatus, String> {
        let mut guard = self.worker.lock().map_err(|_| "事件接收状态异常")?;
        if guard.is_some() { return Err("MATLAB 事件接收已开启".into()); }
        if port == 0 { return Err("端口不能为 0".into()); }
        let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("本机接收端口不可用: {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let token = uuid::Uuid::new_v4().to_string();
        let clock_id = uuid::Uuid::new_v4().to_string();
        let stem = recording.file_stem().unwrap().to_string_lossy();
        let suffix = &clock_id[..8];
        let event_path = recording.with_file_name(format!("{stem}_stimulus_{suffix}.jsonl"));
        let csv_path = event_path.with_extension("csv");
        let journal = OpenOptions::new().write(true).create_new(true).open(&event_path).map_err(|e| e.to_string())?;
        let mut csv = OpenOptions::new().write(true).create_new(true).open(&csv_path).map_err(|e| e.to_string())?;
        csv.write_all(b"\xef\xbb\xbf").map_err(|e|e.to_string())?;
        writeln!(csv, "event_time_utc,event_time_unix_s,received_time_unix_s,receive_delay_ms,session_id,event_id,sequence,stimulus_id,modality,edge,source_getsecs,clock_offset_s,sync_uncertainty_ms,timestamp_source,duration_s,frequency_hz,intensity,intensity_unit,block,trial,location_json,nearest_received_sample_index,alignment_error_ms,metadata_json").map_err(|e| e.to_string())?;
        if let Some(parent) = connection_path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let connection = json!({"protocol":"ifet-matlab-bridge/1", "host":"127.0.0.1", "port":port,
            "token":token, "clock_id":clock_id, "recording_path":recording});
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut config_file = options.open(&connection_path).map_err(|e| e.to_string())?;
        config_file.write_all(serde_json::to_string_pretty(&connection).unwrap().as_bytes()).map_err(|e| e.to_string())?;
        config_file.sync_all().map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        *self.status.lock().unwrap() = BridgeStatus { running: true, port,
            event_path: event_path.to_string_lossy().into(), csv_path: csv_path.to_string_lossy().into(),
            connection_path: connection_path.to_string_lossy().into(), ..Default::default() };
        let status = self.status.clone();
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new().name("ifet-matlab-native-receiver".into()).spawn(move || {
            let mut engine = Engine::new(clock_id, token, journal, csv, marker, status.clone());
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        status.lock().unwrap().connected = true;
                        if let Err(error) = receive_connection(&mut stream, &thread_stop, &mut engine) {
                            status.lock().unwrap().last_error = error;
                        }
                        status.lock().unwrap().connected = false;
                        let _ = engine.audit(json!({"record_type":"disconnect", "host_time_unix_s":engine.now(),
                            "unfinished_stimulus_ids":engine.active.keys().collect::<Vec<_>>()}));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(10)),
                    Err(e) => { status.lock().unwrap().last_error = e.to_string(); break; }
                }
            }
            let _ = engine.audit(json!({"record_type":"receiver_stop", "host_time_unix_s":engine.now(),
                "unfinished_stimulus_ids":engine.active.keys().collect::<Vec<_>>()}));
            let mut snapshot = status.lock().unwrap(); snapshot.running = false; snapshot.connected = false;
        }).map_err(|e| e.to_string())?;
        *guard = Some(Worker { stop, thread });
        Ok(self.status())
    }

    pub fn stop(&self, force: bool) -> Result<BridgeStatus, String> {
        if !force && self.status().active_stimuli != 0 {
            return Err("仍有未收到停止事件的刺激。请先在 MATLAB 停止刺激；异常退出时可使用强制停止并保留未闭合审计。".into());
        }
        if let Some(worker) = self.worker.lock().unwrap().take() {
            worker.stop.store(true, Ordering::Relaxed);
            let _ = worker.thread.join();
        }
        Ok(self.status())
    }
}

impl Drop for MatlabBridgeState { fn drop(&mut self) { let _ = self.stop(true); } }

struct Engine {
    clock_id: String, token: String, epoch: f64, origin: Instant,
    journal: File, csv: File, marker: MarkerWriter, status: Arc<Mutex<BridgeStatus>>,
    session: Option<String>, last_sequence: u64,
    active: HashMap<String, (f64, String)>,
    recent: HashMap<String, (String, Value)>, order: VecDeque<String>,
}

impl Engine {
    fn new(clock_id: String, token: String, journal: File, csv: File, marker: MarkerWriter,
           status: Arc<Mutex<BridgeStatus>>) -> Self {
        Self { clock_id, token, epoch: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64(),
            origin: Instant::now(), journal, csv, marker, status, session: None, last_sequence: 0,
            active: HashMap::new(), recent: HashMap::new(), order: VecDeque::new() }
    }
    fn now(&self) -> f64 { self.epoch + self.origin.elapsed().as_secs_f64() }
    fn audit(&mut self, row: Value) -> Result<(), String> {
        writeln!(self.journal, "{row}").map_err(|e| e.to_string())?;
        self.journal.sync_data().map_err(|e| e.to_string())
    }
    fn process(&mut self, message: Value, received: f64) -> Result<Value, String> {
        if message.get("token").and_then(Value::as_str) != Some(&self.token) { return Err("本机事件凭证不匹配".into()); }
        match message.get("type").and_then(Value::as_str).unwrap_or("") {
            "ping" => Ok(json!({"type":"pong", "request_id":message["request_id"], "clock_id":self.clock_id,
                "server_receive_unix_s":received, "server_send_unix_s":self.now()})),
            "hello" => {
                let session = message["session_id"].as_str().filter(|s| !s.is_empty() && s.len() <= 128).ok_or("会话编号无效")?;
                if self.session.as_deref() != Some(session) {
                    if !self.active.is_empty() { return Err("上一会话仍有未闭合刺激，不能切换会话".into()); }
                    self.session = Some(session.to_owned()); self.last_sequence = 0; self.recent.clear(); self.order.clear();
                }
                self.audit(json!({"record_type":"hello", "session_id":session, "host_time_unix_s":received}))?;
                Ok(json!({"type":"hello_ack", "protocol":"ifet-matlab-bridge/1", "clock_id":self.clock_id,
                    "session_id":session, "last_sequence":self.last_sequence, "recording_ready":true}))
            }
            "event" => self.event(serde_json::from_value(message["event"].clone()).map_err(|e| e.to_string())?, received),
            "finish" => {
                if self.session.as_deref() != message["session_id"].as_str() { return Err("会话编号不匹配".into()); }
                if !self.active.is_empty() { return Err("仍有未收到停止事件的刺激".into()); }
                self.audit(json!({"record_type":"session_finish", "session_id":self.session, "host_time_unix_s":received,
                    "last_sequence":self.last_sequence}))?;
                Ok(json!({"type":"finish_ack", "last_sequence":self.last_sequence}))
            }
            _ => Err("未知事件消息类型".into())
        }
    }
    fn event(&mut self, event: StimulusEvent, received: f64) -> Result<Value, String> {
        let wall_now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_secs_f64();
        if (wall_now - self.now()).abs() > 0.1 {
            return Err("系统墙钟发生跳变，请结束接收并重新开始，避免 EEG 时间对齐错误".into());
        }
        validate_event(&event, &self.clock_id, self.session.as_deref())?;
        let fingerprint = serde_json::to_string(&event).unwrap();
        if let Some((previous, ack)) = self.recent.get(&event.event_id) {
            if previous != &fingerprint { return Err("重复事件编号对应不同内容".into()); }
            let mut ack = ack.clone(); ack["duplicate"] = json!(true); return Ok(ack);
        }
        if event.sequence != self.last_sequence + 1 { return Err(format!("事件序号不连续：需要 {}，收到 {}", self.last_sequence + 1, event.sequence)); }
        let time = event.source_time + event.clock_offset_s;
        if (received - time).abs() > 300.0 || time - received > event.sync_uncertainty_s + 0.1 {
            return Err("刺激时间不在有效范围内，请重新同步时钟".into());
        }
        let duration = match event.edge.as_str() {
            "start" => {
                if self.active.contains_key(&event.stimulus_id) { return Err("该刺激已开始，不能重复开始".into()); }
                if self.active.len() >= 256 { return Err("未闭合刺激数量过多".into()); } None
            }
            _ => {
                let (start, modality) = self.active.get(&event.stimulus_id).ok_or("停止事件没有对应开始事件")?;
                if modality != &event.modality || time < *start { return Err("刺激起止配对或时间顺序异常".into()); } Some(time - start)
            }
        };
        let label = format!("{}{}", if event.modality == "audio" {"声刺激"} else {"光刺激"},
            match event.edge.as_str() {"start"=>"开始", "stop"=>"停止", _=>"异常停止"});
        let alignment = (self.marker)(time, &label, &fingerprint)?;
        let utc = chrono::DateTime::<chrono::Utc>::from_timestamp_micros((time * 1e6).round() as i64)
            .ok_or("刺激 UTC 时间无效")?.to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        self.audit(json!({"record_type":"event", "event_time_utc":utc, "event_time_unix_s":time,
            "received_time_unix_s":received, "receive_delay_ms":(received-time)*1000.0,
            "write_started_unix_s":self.now(), "event":event, "duration_s":duration, "alignment":alignment}))?;
        let meta = &event.metadata;
        let fields = vec![json!(utc),json!(time),json!(received),json!((received-time)*1000.0),
            json!(event.session_id),json!(event.event_id),json!(event.sequence),json!(event.stimulus_id),
            json!(event.modality),json!(event.edge),json!(event.source_time),json!(event.clock_offset_s),
            json!(event.sync_uncertainty_s*1000.0),json!(event.timestamp_source),json!(duration),
            meta["frequency_hz"].clone(),meta["intensity"].clone(),meta["intensity_unit"].clone(),
            meta["block"].clone(),meta["trial"].clone(),meta["location"].clone(),
            alignment["nearest_received_sample_index"].clone(),alignment["alignment_error_ms"].clone(),meta.clone()];
        writeln!(self.csv, "{}", fields.iter().map(csv_value).collect::<Vec<_>>().join(",")).map_err(|e| e.to_string())?;
        self.csv.sync_data().map_err(|e| e.to_string())?;
        let committed = self.now();
        self.audit(json!({"record_type":"commit", "event_id":event.event_id,
            "primary_files_durable_unix_s":committed, "event_to_primary_durable_ms":(committed-time)*1000.0,
            "receive_to_primary_durable_ms":(committed-received)*1000.0}))?;
        if event.edge == "start" { self.active.insert(event.stimulus_id.clone(), (time, event.modality.clone())); }
        else { self.active.remove(&event.stimulus_id); }
        self.last_sequence = event.sequence;
        let acknowledged = self.now();
        let ack = json!({"type":"event_ack", "event_id":event.event_id, "sequence":event.sequence,
            "duplicate":false, "durable":true, "server_ack_unix_s":acknowledged,
            "receive_delay_ms":(received-time)*1000.0, "event_to_durable_ms":(acknowledged-time)*1000.0});
        self.order.push_back(event.event_id.clone());
        self.recent.insert(event.event_id.clone(), (fingerprint, ack.clone()));
        if self.order.len() > MAX_RECENT_ACKS { self.recent.remove(&self.order.pop_front().unwrap()); }
        let mut status = self.status.lock().unwrap();
        status.event_count += 1; status.active_stimuli = self.active.len(); status.last_event = label;
        status.last_receive_delay_ms = Some((received-time)*1000.0);
        status.last_durable_delay_ms = Some((acknowledged-time)*1000.0);
        status.clock_uncertainty_ms = Some(event.sync_uncertainty_s*1000.0); status.last_error.clear();
        Ok(ack)
    }
}

fn csv_value(value: &Value) -> String {
    let raw = match value { Value::Null => String::new(), Value::String(s) => s.clone(), _=>value.to_string() };
    format!("\"{}\"", raw.replace('"', "\"\""))
}

/// Stream closed raw EEG CSVs; live indices are provisional (BLE can arrive later).
pub fn finalize_alignments(recording: &std::path::Path) -> Result<Vec<PathBuf>, String> {
    let parent=recording.parent().ok_or("记录目录无效")?;
    let prefix=format!("{}_stimulus_",recording.file_stem().unwrap().to_string_lossy());
    let mut outputs=Vec::new();
    for entry in std::fs::read_dir(parent).map_err(|e|e.to_string())? {
        let path=entry.map_err(|e|e.to_string())?.path();
        let name=path.file_name().unwrap().to_string_lossy();
        let suffix=name.strip_prefix(&prefix).and_then(|x|x.strip_suffix(".jsonl"));
        if !suffix.is_some_and(|x|x.len()==8 && x.bytes().all(|b|b.is_ascii_hexdigit())) {continue;}
        let output=path.with_file_name(format!("{}_aligned.csv",path.file_stem().unwrap().to_string_lossy()));
        align_journal(recording,&path,&output)?;outputs.push(output);
    }
    Ok(outputs)
}

fn align_journal(recording:&std::path::Path,journal:&std::path::Path,output:&std::path::Path)->Result<(),String>{
    let mut events=Vec::<Value>::new();let mut event_bytes=0usize;
    for line in BufReader::new(File::open(journal).map_err(|e|e.to_string())?).lines(){
        let line=line.map_err(|e|e.to_string())?;
        let row:Value=serde_json::from_str(&line).map_err(|e|e.to_string())?;
        if row["record_type"]=="event"{event_bytes+=line.len();events.push(row);}
        if events.len()>100_000 || event_bytes>64*1024*1024{return Err("事件表过大，请使用独立离线对齐工具".into());}
    }
    events.sort_by(|a,b|a["event_time_unix_s"].as_f64().unwrap().total_cmp(&b["event_time_unix_s"].as_f64().unwrap()));
    let mut target=File::create(output).map_err(|e|e.to_string())?;
    target.write_all(b"\xef\xbb\xbf").map_err(|e|e.to_string())?;
    writeln!(target,"event_id,stimulus_id,modality,edge,event_time_utc,event_time_unix_s,eeg_data_row_1based,eeg_csv_line_1based,eeg_time,eeg_valid,alignment_error_ms,alignment_status,frequency_hz,intensity,intensity_unit,location_json,metadata_json").map_err(|e|e.to_string())?;
    let mut previous:Option<(f64,u64,String,Option<bool>)>=None;let mut position=0usize;let mut backward_jumps=0u64;
    let mut valid_column=None;
    for (index,line) in BufReader::new(File::open(recording).map_err(|e|e.to_string())?).lines().enumerate(){
        let line=line.map_err(|e|e.to_string())?;
        if index==0{valid_column=line.split(',').position(|x|x=="valid");continue;}
        let timestamp=line.split(',').next().ok_or("EEG 时间列缺失")?;
        let time=chrono::DateTime::parse_from_rfc3339(timestamp).map_err(|e|e.to_string())?.timestamp_micros() as f64/1e6;
        let valid=valid_column.and_then(|column|line.split(',').nth(column))
            .and_then(|x|match x{"true"=>Some(true),"false"=>Some(false),_=>None});
        let current=(time,index as u64,timestamp.to_owned(),valid);
        if previous.as_ref().is_some_and(|x|time<x.0){backward_jumps+=1;}
        while position<events.len() && events[position]["event_time_unix_s"].as_f64().unwrap()<=time{
            let event=&events[position];let wanted=event["event_time_unix_s"].as_f64().unwrap();
            let nearest=match &previous{Some(prior) if (prior.0-wanted).abs()<(time-wanted).abs()=>prior,_=>&current};
            let error=(nearest.0-wanted)*1000.0;
            let status=if previous.is_none() && wanted<time{"before_recording"}
                else if error.abs()>20.0{"gap_or_host_clock_reanchor"}
                else if nearest.3==Some(false){"invalid_eeg_sample"}
                else if nearest.3.is_none(){"unknown_eeg_validity"}else{"within_sample_interval"};
            write_aligned_row(&mut target,event,Some(nearest),Some(error),status)?;position+=1;
        }
        previous=Some(current);
    }
    while position<events.len(){
        let event=&events[position];let wanted=event["event_time_unix_s"].as_f64().unwrap();
        write_aligned_row(&mut target,event,previous.as_ref(),previous.as_ref().map(|p|(p.0-wanted)*1000.0),
            if previous.is_some(){"after_recording"}else{"no_eeg_samples"})?;position+=1;
    }
    target.sync_data().map_err(|e|e.to_string())?;
    if backward_jumps>0{return Err(format!("已生成 {}，但 EEG 主机时间存在 {backward_jumps} 次倒退；请人工检查，不能视为硬件时间对齐",output.display()));}
    Ok(())
}

fn write_aligned_row(target:&mut File,event:&Value,nearest:Option<&(f64,u64,String,Option<bool>)>,error:Option<f64>,status:&str)->Result<(),String>{
    let source=&event["event"];let meta=&source["metadata"];
    let values=vec![source["event_id"].clone(),source["stimulus_id"].clone(),source["modality"].clone(),source["edge"].clone(),
        event["event_time_utc"].clone(),event["event_time_unix_s"].clone(),json!(nearest.map(|x|x.1)),
        json!(nearest.map(|x|x.1+1)),json!(nearest.map(|x|&x.2)),json!(nearest.and_then(|x|x.3)),json!(error),json!(status),
        meta["frequency_hz"].clone(),meta["intensity"].clone(),meta["intensity_unit"].clone(),meta["location"].clone(),meta.clone()];
    writeln!(target,"{}",values.iter().map(csv_value).collect::<Vec<_>>().join(",")).map_err(|e|e.to_string())
}

fn validate_event(event: &StimulusEvent, clock_id: &str, session: Option<&str>) -> Result<(), String> {
    if session != Some(event.session_id.as_str()) { return Err("请先建立 MATLAB 会话".into()); }
    if event.clock_id != clock_id { return Err("接收器已重启，请重新同步时钟".into()); }
    if [&event.event_id,&event.stimulus_id,&event.session_id,&event.timestamp_source].iter().any(|s| s.is_empty() || s.len()>128) {
        return Err("事件编号或时间来源无效".into());
    }
    if !["audio","light"].contains(&event.modality.as_str()) || !["start","stop","abort"].contains(&event.edge.as_str()) {
        return Err("刺激类型或起止类型无效".into());
    }
    if !event.metadata.is_object() || !event.source_time.is_finite() || !event.clock_offset_s.is_finite()
        || !event.sync_uncertainty_s.is_finite() || !(0.0..=0.05).contains(&event.sync_uncertainty_s) {
        return Err("参数或时钟不确定度无效（本机要求不超过 50 ms）".into());
    }
    Ok(())
}

fn receive_connection(stream: &mut TcpStream, stop: &AtomicBool, engine: &mut Engine) -> Result<(), String> {
    stream.set_nodelay(true).map_err(|e|e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_millis(200))).map_err(|e|e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(1))).map_err(|e|e.to_string())?;
    let mut pending = Vec::with_capacity(4096); let mut buffer = [0u8;4096];
    while !stop.load(Ordering::Relaxed) {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let received = engine.now();
                for byte in &buffer[..n] {
                    if *byte == b'\n' {
                        let message = serde_json::from_slice::<Value>(&pending).map_err(|e|e.to_string());
                        let result = message.and_then(|m|engine.process(m,received));
                        let reply = match result {
                            Ok(value)=>value,
                            Err(error)=>{engine.status.lock().unwrap().last_error=error.clone();json!({"type":"error","message":error})}
                        };
                        writeln!(stream,"{reply}").map_err(|e|e.to_string())?;
                        pending.clear();
                    } else {
                        pending.push(*byte);
                        if pending.len()>MAX_MESSAGE { return Err("事件消息超过 32 KiB 限制".into()); }
                    }
                }
            }
            Err(e) if matches!(e.kind(),std::io::ErrorKind::TimedOut|std::io::ErrorKind::WouldBlock)=>{},
            Err(e)=>return Err(e.to_string())
        }
    }
    if !pending.is_empty() { return Err("连接中断：收到不完整事件消息，未确认".into()); } Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn engine() -> (Engine, PathBuf) {
        let dir=std::env::temp_dir().join(format!("ifet-bridge-test-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let engine=Engine::new("clock".into(),"token".into(),File::create(dir.join("events.jsonl")).unwrap(),
            File::create(dir.join("events.csv")).unwrap(),Arc::new(|_,_,_|Ok(json!({"nearest_received_sample_index":42}))),
            Arc::new(Mutex::new(BridgeStatus::default()))); (engine,dir)
    }
    fn event(engine: &Engine, sequence: u64, edge: &str) -> StimulusEvent {
        StimulusEvent {event_id:format!("event-{sequence}"),session_id:"session".into(),sequence,
            stimulus_id:"stimulus".into(),modality:"audio".into(),edge:edge.into(),source_time:engine.now(),
            clock_offset_s:0.0,sync_uncertainty_s:0.001,clock_id:"clock".into(),timestamp_source:"test_estimate".into(),
            metadata:json!({"frequency_hz":80,"intensity":1,"intensity_unit":"linear_gain"})}
    }
    #[test] fn pairs_starts_stops_and_deduplicates_exact_retry() {
        let (mut e,dir)=engine();e.session=Some("session".into());
        let start=event(&e,1,"start");let now=e.now();e.event(start.clone(),now).unwrap();
        assert_eq!(e.event(start,now).unwrap()["duplicate"],true);
        assert_eq!(e.status.lock().unwrap().event_count,1);
        let stop=event(&e,2,"stop");let now=e.now();e.event(stop,now).unwrap();assert!(e.active.is_empty());
        assert_eq!(std::fs::read_to_string(dir.join("events.jsonl")).unwrap().lines().count(),4);
    }
    #[test] fn rejects_wrong_clock_or_unpaired_stop_or_missing_sequence() {
        let (mut e,_)=engine();e.session=Some("session".into());let now=e.now();
        assert!(e.event(event(&e,1,"stop"),now).is_err());
        assert!(e.event(event(&e,2,"start"),now).is_err());
        let mut wrong=event(&e,1,"start");wrong.clock_id="old".into();assert!(e.event(wrong,now).is_err());
    }
    #[test] fn keeps_original_onset_when_delivery_is_delayed() {
        let (mut e,dir)=engine();e.session=Some("session".into());let now=e.now();
        let mut start=event(&e,1,"start");start.source_time=now-0.25;
        let ack=e.event(start,now).unwrap();assert!((ack["receive_delay_ms"].as_f64().unwrap()-250.0).abs()<0.001);
        let row:Value=serde_json::from_str(std::fs::read_to_string(dir.join("events.jsonl")).unwrap().lines().next().unwrap()).unwrap();
        assert!((row["event_time_unix_s"].as_f64().unwrap()-(now-0.25)).abs()<1e-6);
    }
    #[test] fn rejects_other_local_clients_without_token() {
        let (mut e,_)=engine();let now=e.now();assert!(e.process(json!({"type":"ping"}),now).is_err());
    }
    #[test] fn final_position_uses_closed_eeg_file_not_live_received_index() {
        let (mut e,dir)=engine();e.session=Some("session".into());
        let origin=e.now()-1.0;let mut start=event(&e,1,"start");start.source_time=origin+0.0012;
        let now=e.now();e.event(start,now).unwrap();
        let raw=dir.join("eeg.csv");let mut file=File::create(&raw).unwrap();
        writeln!(file,"time,sampleRateHz,valid").unwrap();
        for i in 0..3 {
            let time=chrono::DateTime::<chrono::Utc>::from_timestamp_micros(((origin+i as f64*0.002)*1e6).round() as i64).unwrap();
            writeln!(file,"{},500,true",time.to_rfc3339_opts(chrono::SecondsFormat::Micros,true)).unwrap();
        }
        drop(file);let output=dir.join("aligned.csv");align_journal(&raw,&dir.join("events.jsonl"),&output).unwrap();
        let text=std::fs::read_to_string(output).unwrap();
        assert!(text.lines().nth(1).unwrap().contains(",\"2\",\"3\","));
        assert!(text.contains("within_sample_interval"));
    }
}
