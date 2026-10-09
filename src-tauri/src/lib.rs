mod battery;
mod ble;
mod lsl;
mod models;
mod power;
mod protocol;
mod sleep_staging;
pub mod stimulation;
mod stimulus_timeline;

use ble::BleManagerState;
use lsl::{LslConfig, LslManagerState, LslStatus};
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
async fn disconnect_device(state: State<'_, BleManagerState>, stimulation: State<'_, stimulation::StimulationState>) -> Result<(), String> {
    if stimulation.is_active() { stimulation.stop(); }
    state.disconnect_device().await.map_err(to_user_error)
}

#[tauri::command]
async fn send_command(state: State<'_, BleManagerState>, stimulation: State<'_, stimulation::StimulationState>, hex: String) -> Result<(), String> {
    if stimulation.is_active() { return Err("刺激进行中不能发送设备配置命令".into()); }
    state.send_command(hex).await.map_err(to_user_error)
}

#[tauri::command]
async fn set_sample_rate(
    state: State<'_, BleManagerState>,
    stimulation: State<'_, stimulation::StimulationState>,
    sample_rate_hz: u32,
) -> Result<(), String> {
    if stimulation.is_active() { return Err("刺激进行中不能切换采样率，请先停止刺激".into()); }
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
    stimulation: State<'_, stimulation::StimulationState>,
    directory: Option<String>,
) -> Result<String, String> {
    if stimulation.is_active() { return Err("刺激进行中不能更换记录文件".into()); }
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
    state: State<'_, BleManagerState>,
    power: State<'_, PowerManagerState>,
    stimulation: State<'_, stimulation::StimulationState>,
) -> Result<(), String> {
    if stimulation.is_active() { return Err("请先停止刺激实验，等待结束标记保存后再停止 EEG 记录".into()); }
    state.stop_recording().await.map_err(to_user_error)?;
    power.set_recording(false)?;
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

#[tauri::command]
fn stimulus_devices(app: AppHandle) -> Result<stimulation::DeviceList, String> {
    let mut list=stimulation::devices().map_err(to_user_error)?;
    list.monitors=stimulation::monitor_names(&app).map_err(to_user_error)?;Ok(list)
}

fn require_visual_window(window:&tauri::WebviewWindow)->Result<(),String> {
    if window.label()!="stimulus-light" { return Err("此操作仅允许刺激显示窗口调用".into()); } Ok(())
}
#[tauri::command]
fn stimulus_visual_clock(window:tauri::WebviewWindow,state:State<'_,stimulation::StimulationState>)->Result<serde_json::Value,String> {
    require_visual_window(&window)?;state.visual_clock().map_err(to_user_error)
}
#[tauri::command]
fn stimulus_visual_ready(window:tauri::WebviewWindow,state:State<'_,stimulation::StimulationState>,run_id:String)->Result<(),String> {
    require_visual_window(&window)?;state.visual_ready(&run_id).map_err(to_user_error)
}
#[tauri::command]
fn stimulus_visual_rendered(window:tauri::WebviewWindow,state:State<'_,stimulation::StimulationState>,value:stimulation::VisualRendered)->Result<(),String> {
    require_visual_window(&window)?;state.visual_rendered(value).map_err(to_user_error)
}
#[tauri::command]
fn stimulus_visual_benchmark(app:AppHandle,state:State<'_,stimulation::StimulationState>)->Result<stimulation::StimulusStatus,String> {
    state.visual_timing_check(app).map_err(to_user_error)
}

#[tauri::command]
fn stimulus_status(state: State<'_, stimulation::StimulationState>) -> stimulation::StimulusStatus { state.status() }

#[tauri::command]
async fn stimulus_start(app: AppHandle, state: State<'_, stimulation::StimulationState>, ble: State<'_, BleManagerState>,
    config: stimulation::StimulusConfig) -> Result<stimulation::StimulusStatus, String> {
    if !ble.stimulus_stream_recent() { return Err("必须先连接头带并接收到有效 EEG，演示数据不能用于刺激实验".into()); }
    let target = ble.stimulus_recording_target().await.map_err(to_user_error)?;
    state.start(app, config, target).map_err(to_user_error)
}

#[tauri::command]
fn stimulus_stop(state: State<'_, stimulation::StimulationState>) { state.stop(); }

#[tauri::command]
fn stimulus_resume(state: State<'_, stimulation::StimulationState>) -> Result<(), String> { state.resume().map_err(to_user_error) }

#[tauri::command]
async fn stimulus_benchmark(app: AppHandle, state: State<'_, stimulation::StimulationState>) -> Result<serde_json::Value, String> {
    let output = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("timing_checks").join(uuid::Uuid::new_v4().to_string());
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.timing_check(app, output)).await.map_err(|e| e.to_string())?.map_err(to_user_error)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(BleManagerState::default())
        .manage(LslManagerState::default())
        .manage(PowerManagerState::default())
        .manage(SleepStagingClientState::default())
        .manage(stimulation::StimulationState::default())
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
            stimulus_devices, stimulus_status, stimulus_start, stimulus_stop, stimulus_resume, stimulus_benchmark,
            stimulus_visual_clock, stimulus_visual_ready, stimulus_visual_rendered, stimulus_visual_benchmark,
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<stimulation::StimulationState>();
                if state.is_active() { state.stop(); api.prevent_close(); }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
