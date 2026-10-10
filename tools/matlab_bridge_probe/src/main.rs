//! Hardware-free test host using the production TCP receiver, not a mock socket.
#[path = "../../../src-tauri/src/matlab_bridge.rs"] mod matlab_bridge;
use std::{io::Write, sync::{Arc,Mutex, atomic::{AtomicBool,Ordering}}, time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
use serde_json::json;

fn main() {
    let args:Vec<_>=std::env::args().collect();
    let directory=std::path::PathBuf::from(args.get(1).expect("output directory"));
    let port=args.get(2).map(|x|x.parse::<u16>().unwrap()).unwrap_or(45322);
    let seconds=args.get(3).map(|x|x.parse::<u64>().unwrap()).unwrap_or(90);
    std::fs::create_dir_all(&directory).unwrap();
    let recording=directory.join("probe_eeg.csv");
    let producer_stop=Arc::new(AtomicBool::new(false));
    let producer_flag=producer_stop.clone();
    let eeg_path=recording.clone();
    let producer=std::thread::spawn(move|| {
        let mut file=std::io::BufWriter::new(std::fs::File::create(eeg_path).unwrap());
        writeln!(file,"time,sampleRateHz,eeg1,eeg2,eeg3,eeg4,valid").unwrap();
        let epoch=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64();
        let origin=Instant::now();let mut sample=0u64;
        while !producer_flag.load(Ordering::Relaxed) {
            let due=(origin.elapsed().as_secs_f64()*1000.0) as u64;
            while sample<=due {
                let time=chrono::DateTime::<chrono::Utc>::from_timestamp_micros(((epoch+sample as f64/1000.0)*1e6) as i64).unwrap();
                writeln!(file,"{},1000,0,0,0,0,true",time.to_rfc3339_opts(chrono::SecondsFormat::Micros,true)).unwrap();sample+=1;
            }
            file.flush().unwrap(); std::thread::sleep(Duration::from_millis(50));
        }
        file.flush().unwrap(); file.get_ref().sync_data().unwrap();
    });
    let marker=Arc::new(Mutex::new(std::fs::File::create(directory.join("probe_markers.csv")).unwrap()));
    let state=matlab_bridge::MatlabBridgeState::default();
    let marker_callback=Arc::new(move|time:f64,label:&str,note:&str| {
        let mut file=marker.lock().unwrap();
        writeln!(file,"{time},{label},{note}").map_err(|e|e.to_string())?;
        file.sync_data().map_err(|e|e.to_string())?;
        Ok(json!({"nearest_received_sample_index":null,"alignment_error_ms":null}))
    });
    let status=state.start(port,recording,directory.join("connection.json"),marker_callback).unwrap();
    println!("{}",serde_json::to_string(&status).unwrap());
    std::thread::sleep(Duration::from_secs(seconds));
    println!("{}",serde_json::to_string(&state.stop(true).unwrap()).unwrap());
    producer_stop.store(true,Ordering::Relaxed);let _=producer.join();
    matlab_bridge::finalize_alignments(&directory.join("probe_eeg.csv")).unwrap();
}
