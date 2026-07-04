mod ble;
mod dsp;
mod models;
mod protocol;

use ble::BleManagerState;
use models::{DeviceInfo, StatusEvent};
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
    state.connect_device(app, device_id).await.map_err(to_user_error)
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
async fn start_recording(state: State<'_, BleManagerState>, directory: Option<String>) -> Result<String, String> {
    state.start_recording(directory).await.map_err(to_user_error)
}

#[tauri::command]
async fn stop_recording(state: State<'_, BleManagerState>) -> Result<(), String> {
    state.stop_recording().await.map_err(to_user_error)
}

fn to_user_error(error: anyhow::Error) -> String {
    format!("操作失败: {error}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BleManagerState::default())
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
            stop_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
