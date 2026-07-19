mod ble;
mod models;
mod protocol;
mod sleep_staging;

use ble::BleManagerState;
use models::{DeviceInfo, StatusEvent};
use serde_json::Value;
use sleep_staging::SleepStagingClientState;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
async fn scan_devices(state: State<'_, BleManagerState>) -> Result<Vec<DeviceInfo>, String> {
    state.scan_devices().await.map_err(to_user_error)
}

#[tauri::command]
async fn connect_device(
    app: AppHandle,
    state: State<'_, BleManagerState>,
    device_id: String,
) -> Result<(), String> {
    state
        .connect_device(app, device_id)
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
async fn start_recording(
    state: State<'_, BleManagerState>,
    directory: Option<String>,
) -> Result<String, String> {
    state
        .start_recording(directory)
        .await
        .map_err(to_user_error)
}

#[tauri::command]
async fn stop_recording(state: State<'_, BleManagerState>) -> Result<(), String> {
    state.stop_recording().await.map_err(to_user_error)
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

fn to_user_error(error: anyhow::Error) -> String {
    format!("操作失败: {error}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(BleManagerState::default())
        .manage(SleepStagingClientState::default())
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
            start_recording,
            stop_recording,
            sleep_staging_health,
            sleep_staging_reset,
            sleep_staging_step,
            sleep_demo_reset,
            sleep_demo_blink,
            sleep_demo_blink_calibration,
            sleep_demo_config,
            sleep_demo_step,
            sleep_staging_runtime_info,
            sleep_staging_start,
            sleep_staging_stop,
            sleep_staging_open_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
