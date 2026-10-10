mod battery;
mod ble;
mod lsl;
mod matlab_bridge;
mod models;
mod power;
mod protocol;
mod sleep_staging;

use ble::BleManagerState;
use lsl::{LslConfig, LslManagerState, LslStatus};
use matlab_bridge::{BridgeStatus, MatlabBridgeState};
use models::{DeviceInfo, StatusEvent};
use power::{PowerManagerState, PowerPreventionStatus};
use serde_json::Value;
use sleep_staging::SleepStagingClientState;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
async fn scan_devices(state: State<'_, BleManagerState>) -> Result<Vec<DeviceInfo>, String> {
    state.scan_devices().await.map_err(to_user_error)
}

#[tauri::command]
async fn connect_device(
    app: AppHandle,
    state: State<'_, BleManagerState>,
    lsl: State<'_, LslManagerState>,
    device_id: String,
) -> Result<(), String> {
    state
        .connect_device(app, device_id, lsl.publisher())
        .await
        .map_err(to_user_error)
}

#[tauri::command]
async fn disconnect_device(state: State<'_, BleManagerState>) -> Result<(), String> {
    state.disconnect_device().await.map_err(to_user_error)
}

#[tauri::command]
async fn send_command(state: State<'_, BleManagerState>, hex: String) -> Result<(), String> {
    state.send_command(hex).await.map_err(to_user_error)
}

#[tauri::command]
async fn set_sample_rate(
    state: State<'_, BleManagerState>,
    sample_rate_hz: u32,
) -> Result<(), String> {
    state
        .set_sample_rate(sample_rate_hz)
        .await
        .map_err(to_user_error)
}

#[tauri::command]
async fn start_recording(
    app: AppHandle,
    state: State<'_, BleManagerState>,
    power: State<'_, PowerManagerState>,
    directory: Option<String>,
) -> Result<String, String> {
    let directory = match directory.filter(|value| !value.trim().is_empty()) {
        Some(value) => Some(value),
        None => {
            let path = app
                .path()
                .app_local_data_dir()
                .map_err(|error| format!("操作失败: 无法确定记录目录: {error}"))?
                .join("recordings");
            Some(path.to_string_lossy().to_string())
        }
    };
    power.set_recording(true)?;
    match state.start_recording(directory).await {
        Ok(path) => Ok(path),
        Err(error) => {
            let _ = power.set_recording(false);
            Err(to_user_error(error))
        }
    }
}

#[tauri::command]
async fn stop_recording(
    app: AppHandle,
    state: State<'_, BleManagerState>,
    power: State<'_, PowerManagerState>,
    bridge: State<'_, MatlabBridgeState>,
) -> Result<(), String> {
    if bridge.status().running {
        return Err("请先停止 MATLAB 事件接收，再停止 EEG 记录，以免漏记刺激停止事件".into());
    }
    let path=state.stimulus_recording_path().await.ok();
    state.stop_recording().await.map_err(to_user_error)?;
    power.set_recording(false)?;
    if let Some(path)=path {
        bridge.alignment_status(true,String::new(),String::new());
        tauri::async_runtime::spawn(async move {
            let result=tauri::async_runtime::spawn_blocking(move||matlab_bridge::finalize_alignments(&path)).await;
            match result {
                Ok(Ok(paths))=>app.state::<MatlabBridgeState>().alignment_status(false,
                    paths.iter().map(|p|p.to_string_lossy()).collect::<Vec<_>>().join("\n"),String::new()),
                Ok(Err(error))=>app.state::<MatlabBridgeState>().alignment_status(false,String::new(),error),
                Err(error)=>app.state::<MatlabBridgeState>().alignment_status(false,String::new(),error.to_string()),
            }
        });
    }
    Ok(())
}

fn resolve_recording_directory(
    app: &AppHandle,
    directory: Option<String>,
) -> Result<String, String> {
    match directory.filter(|value| !value.trim().is_empty()) {
        Some(value) => Ok(value),
        None => app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("操作失败: 无法确定记录目录: {error}"))
            .map(|path| path.join("recordings").to_string_lossy().to_string()),
    }
}

#[tauri::command]
async fn start_battery_recording(
    app: AppHandle,
    state: State<'_, BleManagerState>,
    directory: Option<String>,
) -> Result<String, String> {
    let directory = resolve_recording_directory(&app, directory)?;
    state
        .start_battery_recording(Some(directory))
        .await
        .map_err(to_user_error)
}

#[tauri::command]
async fn stop_battery_recording(state: State<'_, BleManagerState>) -> Result<(), String> {
    state.stop_battery_recording().await.map_err(to_user_error)
}

#[tauri::command]
fn set_acquisition_sleep_prevention(
    state: State<'_, PowerManagerState>,
    active: bool,
) -> Result<PowerPreventionStatus, String> {
    state.set_acquisition_mode(active)
}

#[tauri::command]
fn power_prevention_status(
    state: State<'_, PowerManagerState>,
) -> Result<PowerPreventionStatus, String> {
    state.status()
}

#[tauri::command]
fn matlab_bridge_status(state: State<'_, MatlabBridgeState>) -> BridgeStatus { state.status() }

#[tauri::command]
async fn matlab_bridge_start(app: AppHandle, state: State<'_, MatlabBridgeState>,
    ble: State<'_, BleManagerState>, power: State<'_, PowerManagerState>, port: u16) -> Result<BridgeStatus, String> {
    if state.status().running { return Err("MATLAB 事件接收已开启".into()); }
    if state.status().alignment_pending { return Err("正在完成上一记录的刺激位置对齐，请稍候".into()); }
    let path = ble.stimulus_recording_path().await.map_err(to_user_error)?;
    let config = app.path().home_dir().map_err(|e|e.to_string())?
        .join("Documents").join("IFET_MATLAB_BRIDGE").join("connection.json");
    power.set_stimulus_receiver(true)?;
    let expected = path.clone();
    let marker_app = app.clone();
    let marker = std::sync::Arc::new(move |time:f64, label:&str, note:&str| {
        let result = tauri::async_runtime::block_on(marker_app.state::<BleManagerState>()
            .append_stimulus_marker(&expected, time, label, note));
        result.map(|x| {
            if let Ok(event) = serde_json::from_str::<matlab_bridge::StimulusEvent>(note) {
                let _ = marker_app.emit("matlab://event", serde_json::json!({"eventId":event.event_id,
                    "timestamp":time*1000.0,"label":label,"modality":event.modality,"edge":event.edge}));
            }
            serde_json::to_value(x).unwrap()
        }).map_err(|e|e.to_string())
    });
    match state.start(port, path, config, marker) {
        Ok(status)=>Ok(status),
        Err(error)=>{let _=power.set_stimulus_receiver(false);Err(error)}
    }
}

#[tauri::command]
fn matlab_bridge_stop(state: State<'_, MatlabBridgeState>, power: State<'_, PowerManagerState>, force: bool) -> Result<BridgeStatus,String> {
    let status=state.stop(force)?;power.set_stimulus_receiver(false)?;Ok(status)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn append_debug_marker(
    state: State<'_, BleManagerState>,
    lsl: State<'_, LslManagerState>,
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
) -> Result<String, String> {
    let marker_participant_id = participant_id.clone();
    let marker_label = label.clone();
    let marker_note = note.clone();
    let marker_action = algorithm_action.clone();
    let path = state
        .append_debug_marker(
            participant_id,
            label,
            note,
            sample_count,
            device_flag,
            algorithm_action,
            eeg1,
            eeg2,
            eeg3,
            eeg4,
        )
        .await
        .map_err(to_user_error)?;
    // LSL 是并行输出：未启用或临时失败不能破坏本地 CSV 标记。
    let _ = lsl
        .publish_marker(
            marker_label,
            marker_note,
            marker_participant_id,
            sample_count,
            device_flag,
            marker_action,
        )
        .await;
    Ok(path)
}

#[tauri::command]
async fn lsl_configure(
    state: State<'_, LslManagerState>,
    config: LslConfig,
) -> Result<LslStatus, String> {
    state.configure(config).await
}

#[tauri::command]
fn lsl_status(state: State<'_, LslManagerState>) -> LslStatus {
    state.status()
}

#[tauri::command]
async fn lsl_test_marker(state: State<'_, LslManagerState>) -> Result<LslStatus, String> {
    state
        .publish_marker(
            "LSL 测试标记".to_string(),
            "由上位机设置页发送".to_string(),
            String::new(),
            0,
            None,
            "LSL 测试".to_string(),
        )
        .await
}

#[tauri::command]
async fn sleep_staging_health(
    state: State<'_, SleepStagingClientState>,
    endpoint: String,
) -> Result<Value, String> {
    state.health(&endpoint).await
}

#[tauri::command]
async fn sleep_staging_reset(
    state: State<'_, SleepStagingClientState>,
    endpoint: String,
    session_id: String,
) -> Result<Value, String> {
    state.reset(&endpoint, session_id).await
}

#[tauri::command]
async fn sleep_staging_step(
    state: State<'_, SleepStagingClientState>,
    endpoint: String,
    request: Value,
) -> Result<Value, String> {
    state.step(&endpoint, request).await
}

#[tauri::command]
async fn sleep_demo_reset(
    state: State<'_, SleepStagingClientState>,
    endpoint: String,
    session_id: String,
    blink_interaction_enabled: bool,
) -> Result<Value, String> {
    state
        .demo_reset(&endpoint, session_id, blink_interaction_enabled)
        .await
}

#[tauri::command]
async fn sleep_demo_blink(
    state: State<'_, SleepStagingClientState>,
    endpoint: String,
    session_id: String,
    enabled: bool,
) -> Result<Value, String> {
    state.demo_blink(&endpoint, session_id, enabled).await
}

#[tauri::command]
async fn sleep_demo_blink_calibration(
    state: State<'_, SleepStagingClientState>,
    endpoint: String,
    session_id: String,
    action: String,
) -> Result<Value, String> {
    state
        .demo_blink_calibration(&endpoint, session_id, action)
        .await
}

#[tauri::command]
async fn sleep_demo_alpha_calibration(
    state: State<'_, SleepStagingClientState>,
    endpoint: String,
    session_id: String,
    kind: String,
    started_at: Option<String>,
) -> Result<Value, String> {
    state
        .demo_alpha_calibration(&endpoint, session_id, kind, started_at)
        .await
}

#[tauri::command]
async fn sleep_demo_config(
    state: State<'_, SleepStagingClientState>,
    endpoint: String,
    session_id: String,
    alpha_volume_mode: String,
    session_active: bool,
) -> Result<Value, String> {
    state
        .demo_config(&endpoint, session_id, alpha_volume_mode, session_active)
        .await
}

#[tauri::command]
async fn sleep_demo_step(
    state: State<'_, SleepStagingClientState>,
    endpoint: String,
    request: Value,
) -> Result<Value, String> {
    state.demo_step(&endpoint, request).await
}

#[tauri::command]
fn sleep_staging_runtime_info(
    app: AppHandle,
    state: State<'_, SleepStagingClientState>,
) -> Result<sleep_staging::SleepStagingRuntimeInfo, String> {
    state.runtime_info(&app)
}

#[tauri::command]
fn sleep_staging_start(
    app: AppHandle,
    state: State<'_, SleepStagingClientState>,
    port: u16,
) -> Result<sleep_staging::SleepStagingRuntimeInfo, String> {
    state.start_service(&app, port)
}

#[tauri::command]
fn sleep_staging_stop(
    app: AppHandle,
    state: State<'_, SleepStagingClientState>,
) -> Result<sleep_staging::SleepStagingRuntimeInfo, String> {
    state.stop_service(&app)
}

#[tauri::command]
fn sleep_staging_open_dir(
    app: AppHandle,
    state: State<'_, SleepStagingClientState>,
) -> Result<sleep_staging::SleepStagingRuntimeInfo, String> {
    state.open_algorithm_dir(&app)
}

#[tauri::command]
fn sleep_algorithm_import(
    app: AppHandle,
    state: State<'_, SleepStagingClientState>,
    source: String,
) -> Result<sleep_staging::SleepStagingRuntimeInfo, String> {
    state.import_algorithm_package(&app, source)
}

#[tauri::command]
fn sleep_algorithm_activate(
    app: AppHandle,
    state: State<'_, SleepStagingClientState>,
    package_id: String,
    version: String,
) -> Result<sleep_staging::SleepStagingRuntimeInfo, String> {
    state.activate_algorithm_package(&app, package_id, version)
}

#[tauri::command]
fn sleep_algorithm_rollback(
    app: AppHandle,
    state: State<'_, SleepStagingClientState>,
) -> Result<sleep_staging::SleepStagingRuntimeInfo, String> {
    state.rollback_algorithm_package(&app)
}

fn to_user_error(error: anyhow::Error) -> String {
    format!("操作失败: {error}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(BleManagerState::default())
        .manage(LslManagerState::default())
        .manage(PowerManagerState::default())
        .manage(MatlabBridgeState::default())
        .manage(SleepStagingClientState::default())
        .on_window_event(|window,event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let recording=window.state::<PowerManagerState>().status().map(|s|s.recording).unwrap_or(false);
                if recording || window.state::<MatlabBridgeState>().status().running {
                    // Keep native acquisition/telemetry alive if the main window
                    // is accidentally closed during an experiment. Quit is distinct.
                    api.prevent_close();
                    #[cfg(target_os = "macos")]
                    let _=window.hide();
                    #[cfg(not(target_os = "macos"))]
                    let _=window.minimize();
                }
            }
        })
        .setup(|app| {
            let _ = app.emit(
                "ble://status",
                StatusEvent {
                    message: "客户端已启动".to_string(),
                    connected: false,
                },
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_devices,
            connect_device,
            disconnect_device,
            send_command,
            set_sample_rate,
            start_recording,
            stop_recording,
            start_battery_recording,
            stop_battery_recording,
            set_acquisition_sleep_prevention,
            power_prevention_status,
            matlab_bridge_start,
            matlab_bridge_stop,
            matlab_bridge_status,
            append_debug_marker,
            lsl_configure,
            lsl_status,
            lsl_test_marker,
            sleep_staging_health,
            sleep_staging_reset,
            sleep_staging_step,
            sleep_demo_reset,
            sleep_demo_blink,
            sleep_demo_blink_calibration,
            sleep_demo_alpha_calibration,
            sleep_demo_config,
            sleep_demo_step,
            sleep_staging_runtime_info,
            sleep_staging_start,
            sleep_staging_stop,
            sleep_staging_open_dir,
            sleep_algorithm_import,
            sleep_algorithm_activate,
            sleep_algorithm_rollback
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app,event| {
            if matches!(&event, tauri::RunEvent::Exit) {
                // Flush local data on normal Quit, but never manufacture a
                // physical stimulus offset if MATLAB is still active.
                let _=app.state::<MatlabBridgeState>().stop(true);
                let _=tauri::async_runtime::block_on(app.state::<BleManagerState>().stop_recording());
                let _=tauri::async_runtime::block_on(app.state::<BleManagerState>().stop_battery_recording());
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows:false, .. } = event {
                if let Some(window)=app.get_webview_window("main") { let _=window.show();let _=window.set_focus(); }
            }
            #[cfg(not(target_os = "macos"))]
            let _=(app,event);
        });
}
