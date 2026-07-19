use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const ALGORITHM_FOLDER: &str = "SleepStagingAlgorithm_PC_v1.2.0";
const LEGACY_ALGORITHM_FOLDER: &str = "SleepStagingAlgorithm_PC_v1.0";
const BUNDLED_SERVICE_FOLDER: &str = "runtime";
#[cfg(windows)]
const BUNDLED_SERVICE_EXE: &str = "ifet-sleep-service.exe";
#[cfg(not(windows))]
const BUNDLED_SERVICE_EXE: &str = "ifet-sleep-service";

#[derive(Serialize)]
pub struct SleepStagingRuntimeInfo {
    pub algorithm_dir: String,
    pub venv_ready: bool,
    pub service_running: bool,
}

pub struct SleepStagingClientState {
    client: Client,
    child: Mutex<Option<SleepStagingProcess>>,
}

struct SleepStagingProcess {
    child: Child,
    #[cfg(windows)]
    job: OwnedHandle,
}

impl Default for SleepStagingClientState {
    fn default() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("sleep staging HTTP client should build");
        Self {
            client,
            child: Mutex::new(None),
        }
    }
}

impl SleepStagingClientState {
    pub async fn health(&self, endpoint: &str) -> Result<Value, String> {
        let url = local_url(endpoint, "/health")?;
        self.send(self.client.get(url)).await
    }

    pub async fn reset(&self, endpoint: &str, session_id: String) -> Result<Value, String> {
        let url = local_url(endpoint, "/reset")?;
        self.send(
            self.client
                .post(url)
                .json(&json!({ "session_id": session_id })),
        )
        .await
    }

    pub async fn step(&self, endpoint: &str, request: Value) -> Result<Value, String> {
        let url = local_url(endpoint, "/step")?;
        self.send(self.client.post(url).json(&request)).await
    }

    pub async fn demo_reset(
        &self,
        endpoint: &str,
        session_id: String,
        blink_interaction_enabled: bool,
    ) -> Result<Value, String> {
        let url = local_url(endpoint, "/demo/reset")?;
        self.send(self.client.post(url).json(&json!({
            "session_id": session_id,
            "blink_interaction_enabled": blink_interaction_enabled,
        })))
        .await
    }

    pub async fn demo_blink(
        &self,
        endpoint: &str,
        session_id: String,
        enabled: bool,
    ) -> Result<Value, String> {
        let url = local_url(endpoint, "/demo/blink")?;
        self.send(self.client.post(url).json(&json!({
            "session_id": session_id,
            "enabled": enabled,
        })))
        .await
    }

    pub async fn demo_blink_calibration(
        &self,
        endpoint: &str,
        session_id: String,
        action: String,
    ) -> Result<Value, String> {
        let url = local_url(endpoint, "/demo/blink-calibration")?;
        self.send(self.client.post(url).json(&json!({
            "session_id": session_id,
            "action": action,
        })))
        .await
    }

    pub async fn demo_config(
        &self,
        endpoint: &str,
        session_id: String,
        alpha_volume_mode: String,
        session_active: bool,
    ) -> Result<Value, String> {
        let url = local_url(endpoint, "/demo/config")?;
        self.send(self.client.post(url).json(&json!({
            "session_id": session_id,
            "alpha_volume_mode": alpha_volume_mode,
            "session_active": session_active,
        })))
        .await
    }

    pub async fn demo_step(&self, endpoint: &str, request: Value) -> Result<Value, String> {
        let url = local_url(endpoint, "/demo/step")?;
        self.send(self.client.post(url).json(&request)).await
    }

    pub fn runtime_info(&self, app: &AppHandle) -> Result<SleepStagingRuntimeInfo, String> {
        let algorithm_dir = ensure_algorithm_dir(app)?;
        let venv_ready =
            bundled_service_path(&algorithm_dir).is_file() || python_path(&algorithm_dir).is_file();
        let service_running = self.service_running()?;
        Ok(SleepStagingRuntimeInfo {
            algorithm_dir: algorithm_dir.to_string_lossy().to_string(),
            venv_ready,
            service_running,
        })
    }

    pub fn start_service(
        &self,
        app: &AppHandle,
        port: u16,
    ) -> Result<SleepStagingRuntimeInfo, String> {
        let algorithm_dir = ensure_algorithm_dir(app)?;

        let mut child = self
            .child
            .lock()
            .map_err(|_| "睡眠算法进程状态不可用".to_string())?;
        if let Some(process) = child.as_mut() {
            if process
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                drop(child);
                return self.runtime_info(app);
            }
        }

        let bundled_service = bundled_service_path(&algorithm_dir);
        let mut command = if bundled_service.is_file() {
            Command::new(&bundled_service)
        } else {
            let python = python_path(&algorithm_dir);
            if !python.is_file() {
                return Err(
                    "睡眠算法运行时不可用，请重新安装客户端或运行对应平台的环境初始化脚本"
                        .to_string(),
                );
            }
            let mut command = Command::new(&python);
            command.arg(algorithm_dir.join("service.py"));
            command
        };
        command
            .current_dir(&algorithm_dir)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("--state-path")
            .arg(algorithm_dir.join("runtime_state").join("sleep_state.npz"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        #[cfg(unix)]
        command.process_group(0);

        *child = Some(SleepStagingProcess::spawn(&mut command)?);
        drop(child);
        self.runtime_info(app)
    }

    pub fn stop_service(&self, app: &AppHandle) -> Result<SleepStagingRuntimeInfo, String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "睡眠算法进程状态不可用".to_string())?;
        if let Some(mut process) = child.take() {
            process.terminate();
        }
        drop(child);
        self.runtime_info(app)
    }

    pub fn open_algorithm_dir(&self, app: &AppHandle) -> Result<SleepStagingRuntimeInfo, String> {
        let info = self.runtime_info(app)?;
        open_directory(Path::new(&info.algorithm_dir))?;
        Ok(info)
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value, String> {
        let response = request
            .send()
            .await
            .map_err(|error| format!("睡眠算法服务不可用: {error}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("读取睡眠算法响应失败: {error}"))?;
        if !status.is_success() {
            return Err(format!("睡眠算法服务返回 {status}: {body}"));
        }
        serde_json::from_str(&body).map_err(|error| format!("睡眠算法响应格式无效: {error}"))
    }

    fn service_running(&self) -> Result<bool, String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "睡眠算法进程状态不可用".to_string())?;
        let Some(process) = child.as_mut() else {
            return Ok(false);
        };
        match process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
        {
            None => Ok(true),
            Some(_) => {
                *child = None;
                Ok(false)
            }
        }
    }
}

impl Drop for SleepStagingClientState {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            if let Some(process) = child.as_mut() {
                process.terminate();
            }
        }
    }
}

impl SleepStagingProcess {
    fn spawn(command: &mut Command) -> Result<Self, String> {
        let mut child = command
            .spawn()
            .map_err(|error| format!("启动睡眠算法服务失败: {error}"))?;

        #[cfg(windows)]
        {
            let job = create_kill_on_close_job(&child).map_err(|error| {
                let _ = child.kill();
                let _ = child.wait();
                format!("初始化睡眠算法进程管理失败: {error}")
            })?;
            return Ok(Self { child, job });
        }

        #[cfg(not(windows))]
        Ok(Self { child })
    }

    fn terminate(&mut self) {
        #[cfg(windows)]
        unsafe {
            let _ = TerminateJobObject(self.job.as_raw_handle() as _, 1);
        }

        #[cfg(unix)]
        {
            let process_group = self.child.id() as i32;
            unsafe {
                let _ = libc::killpg(process_group, libc::SIGTERM);
            }
            for _ in 0..20 {
                if self.child.try_wait().ok().flatten().is_some() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            unsafe {
                let _ = libc::killpg(process_group, libc::SIGKILL);
            }
        }

        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
fn create_kill_on_close_job(child: &Child) -> Result<OwnedHandle, std::io::Error> {
    unsafe {
        let raw_job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw_job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let job = OwnedHandle::from_raw_handle(raw_job as _);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job.as_raw_handle() as _,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        if AssignProcessToJobObject(job.as_raw_handle() as _, child.as_raw_handle() as _) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }
}
fn ensure_algorithm_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("读取应用资源目录失败: {error}"))?;
    let source = [
        resource_dir.join("resources").join(ALGORITHM_FOLDER),
        resource_dir.join(ALGORITHM_FOLDER),
    ]
    .into_iter()
    .find(|candidate| candidate.join("algorithm_manifest.json").is_file())
    .ok_or_else(|| "安装包中未找到睡眠算法资源".to_string())?;
    let destination = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("读取应用数据目录失败: {error}"))?
        .join(ALGORITHM_FOLDER);
    let source_manifest = fs::read(source.join("algorithm_manifest.json"))
        .map_err(|error| format!("读取算法版本失败: {error}"))?;
    let destination_manifest = fs::read(destination.join("algorithm_manifest.json")).ok();
    if destination_manifest.as_deref() != Some(source_manifest.as_slice())
        || !destination.join("service.py").is_file()
    {
        copy_dir_recursive(&source, &destination)?;
    }
    Ok(destination)
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| format!("创建算法目录失败: {error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("读取算法资源失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取算法资源失败: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("复制算法资源失败: {error}"))?;
        }
    }
    Ok(())
}

fn python_path(algorithm_dir: &Path) -> PathBuf {
    let current = venv_python_path(algorithm_dir);
    if current.is_file() {
        return current;
    }
    algorithm_dir
        .parent()
        .map(|parent| venv_python_path(&parent.join(LEGACY_ALGORITHM_FOLDER)))
        .filter(|legacy| legacy.is_file())
        .unwrap_or(current)
}

fn venv_python_path(algorithm_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        algorithm_dir
            .join(".venv")
            .join("Scripts")
            .join("python.exe")
    }
    #[cfg(not(windows))]
    {
        algorithm_dir.join(".venv").join("bin").join("python3")
    }
}

fn bundled_service_path(algorithm_dir: &Path) -> PathBuf {
    algorithm_dir
        .join(BUNDLED_SERVICE_FOLDER)
        .join(BUNDLED_SERVICE_EXE)
}

fn open_directory(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let opener = "explorer.exe";
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let opener = "xdg-open";

    Command::new(opener)
        .arg(path)
        .spawn()
        .map_err(|error| format!("打开算法目录失败: {error}"))?;
    Ok(())
}

fn local_url(endpoint: &str, path: &str) -> Result<Url, String> {
    let mut url = Url::parse(endpoint.trim()).map_err(|_| "睡眠算法服务地址无效".to_string())?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "http" || !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return Err("睡眠算法服务仅允许本机 HTTP 地址".to_string());
    }
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::{bundled_service_path, local_url, venv_python_path, BUNDLED_SERVICE_EXE};
    use std::path::Path;

    #[test]
    fn accepts_only_local_http_endpoints() {
        assert_eq!(
            local_url("http://127.0.0.1:8765/", "/step")
                .expect("local endpoint")
                .as_str(),
            "http://127.0.0.1:8765/step"
        );
        assert!(local_url("https://127.0.0.1:8765", "/step").is_err());
        assert!(local_url("http://example.com:8765", "/step").is_err());
    }

    #[test]
    fn resolves_bundled_service_inside_algorithm_directory() {
        assert_eq!(
            bundled_service_path(Path::new("algorithm")),
            Path::new("algorithm")
                .join("runtime")
                .join(BUNDLED_SERVICE_EXE)
        );
    }

    #[test]
    fn resolves_platform_virtual_environment_python() {
        let path = venv_python_path(Path::new("algorithm"));
        #[cfg(windows)]
        assert_eq!(path, Path::new("algorithm/.venv/Scripts/python.exe"));
        #[cfg(not(windows))]
        assert_eq!(path, Path::new("algorithm/.venv/bin/python3"));
    }
}
