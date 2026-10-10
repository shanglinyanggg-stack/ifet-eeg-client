use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{self, Read, Write},
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
const ALGORITHM_STORE_FOLDER: &str = "algorithms";
const PACKAGE_STORE_FOLDER: &str = "packages";
const SELECTION_FILE: &str = "current.json";
const ALGORITHM_SIGNATURE_FILE: &str = "SIGNATURE.ed25519";
const ALGORITHM_UPDATE_PUBLIC_KEY: [u8; 32] = [
    0x1e, 0x3b, 0x21, 0xf1, 0xc0, 0x26, 0x4a, 0xef, 0xc7, 0xf5, 0xad, 0x18, 0x29, 0x0d, 0xdb, 0x30,
    0xdb, 0x33, 0x55, 0x30, 0x4c, 0x86, 0xed, 0x07, 0x44, 0xaa, 0x54, 0x91, 0x6d, 0x0a, 0x1b, 0x92,
];
const MINIMUM_HOST_API: u32 = 2;
const MAXIMUM_HOST_API: u32 = 3;
#[cfg(windows)]
const BUNDLED_SERVICE_EXE: &str = "ifet-sleep-service.exe";
#[cfg(not(windows))]
const BUNDLED_SERVICE_EXE: &str = "ifet-sleep-service";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AlgorithmPackageInfo {
    pub package_id: String,
    pub display_name: String,
    pub version: String,
    pub channel: String,
    pub algorithm_profile: String,
    pub release_approved: bool,
    pub active: bool,
    pub bundled: bool,
    pub compatible: bool,
    pub calibration_schema_version: Option<String>,
    pub path: String,
}

#[derive(Serialize)]
pub struct SleepStagingRuntimeInfo {
    pub algorithm_dir: String,
    pub venv_ready: bool,
    pub service_running: bool,
    pub active_package: AlgorithmPackageInfo,
    pub available_packages: Vec<AlgorithmPackageInfo>,
    pub last_known_good: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct AlgorithmManifest {
    package_id: String,
    #[serde(default)]
    display_name: String,
    version: String,
    #[serde(default = "default_channel")]
    channel: String,
    #[serde(default)]
    algorithm_profile: String,
    #[serde(default)]
    release_approved: bool,
    #[serde(default)]
    host_api: HostApiRange,
    calibration_schema_version: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct HostApiRange {
    #[serde(default)]
    minimum: u32,
    #[serde(default)]
    maximum: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AlgorithmSelection {
    active_package_id: String,
    active_version: String,
    last_known_good_package_id: Option<String>,
    last_known_good_version: Option<String>,
}

fn default_channel() -> String {
    "experimental".to_string()
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

    pub async fn demo_alpha_calibration(
        &self,
        endpoint: &str,
        session_id: String,
        kind: String,
        started_at: Option<String>,
    ) -> Result<Value, String> {
        let url = local_url(endpoint, "/demo/alpha-calibration")?;
        self.send(self.client.post(url).json(&json!({
            "session_id": session_id,
            "kind": kind,
            "started_at": started_at,
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
        let store = ensure_algorithm_store(app)?;
        let algorithm_dir = store.active_dir.clone();
        let venv_ready =
            bundled_service_path(&algorithm_dir).is_file() || python_path(&algorithm_dir).is_file();
        let service_running = self.service_running()?;
        Ok(SleepStagingRuntimeInfo {
            algorithm_dir: algorithm_dir.to_string_lossy().to_string(),
            venv_ready,
            service_running,
            active_package: store.active_package,
            available_packages: store.packages,
            last_known_good: store.last_known_good,
        })
    }

    pub fn start_service(
        &self,
        app: &AppHandle,
        port: u16,
    ) -> Result<SleepStagingRuntimeInfo, String> {
        let store = ensure_algorithm_store(app)?;
        let algorithm_dir = store.active_dir;
        let state_path = algorithm_state_path(app, &store.active_package)?;
        if let Some(parent) = state_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建算法状态目录失败: {error}"))?;
        }

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
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .arg("--state-path")
            .arg(state_path)
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

    pub fn import_algorithm_package(
        &self,
        app: &AppHandle,
        source: String,
    ) -> Result<SleepStagingRuntimeInfo, String> {
        self.stop_process()?;
        import_algorithm_package(app, Path::new(source.trim()))?;
        self.runtime_info(app)
    }

    pub fn activate_algorithm_package(
        &self,
        app: &AppHandle,
        package_id: String,
        version: String,
    ) -> Result<SleepStagingRuntimeInfo, String> {
        self.stop_process()?;
        activate_algorithm_package(app, &package_id, &version)?;
        self.runtime_info(app)
    }

    pub fn rollback_algorithm_package(
        &self,
        app: &AppHandle,
    ) -> Result<SleepStagingRuntimeInfo, String> {
        self.stop_process()?;
        rollback_algorithm_package(app)?;
        self.runtime_info(app)
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

    fn stop_process(&self) -> Result<(), String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "睡眠算法进程状态不可用".to_string())?;
        if let Some(mut process) = child.take() {
            process.terminate();
        }
        Ok(())
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
        #[allow(unused_mut)]
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
struct AlgorithmStore {
    active_dir: PathBuf,
    active_package: AlgorithmPackageInfo,
    packages: Vec<AlgorithmPackageInfo>,
    last_known_good: Option<String>,
}

fn bundled_algorithm_source(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("读取应用资源目录失败: {error}"))?;
    [
        resource_dir.join("resources").join(ALGORITHM_FOLDER),
        resource_dir.join(ALGORITHM_FOLDER),
    ]
    .into_iter()
    .find(|candidate| candidate.join("algorithm_manifest.json").is_file())
    .ok_or_else(|| "安装包中未找到睡眠算法资源".to_string())
}

fn algorithm_store_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("读取应用数据目录失败: {error}"))?;
    Ok(root.join(ALGORITHM_STORE_FOLDER))
}

fn algorithm_state_path(
    app: &AppHandle,
    algorithm_package: &AlgorithmPackageInfo,
) -> Result<PathBuf, String> {
    Ok(algorithm_store_root(app)?
        .join("state")
        .join(sanitize_component(&algorithm_package.package_id)?)
        .join(sanitize_component(&algorithm_package.version)?)
        .join("sleep_state.npz"))
}

fn ensure_algorithm_store(app: &AppHandle) -> Result<AlgorithmStore, String> {
    let source = bundled_algorithm_source(app)?;
    let builtin_manifest = read_manifest(&source)?;
    let root = algorithm_store_root(app)?;
    let packages_root = root.join(PACKAGE_STORE_FOLDER);
    fs::create_dir_all(&packages_root).map_err(|error| format!("创建算法包目录失败: {error}"))?;
    let builtin_dir = package_path(&packages_root, &builtin_manifest)?;
    let source_manifest = fs::read(source.join("algorithm_manifest.json"))
        .map_err(|error| format!("读取内置算法清单失败: {error}"))?;
    let destination_manifest = fs::read(builtin_dir.join("algorithm_manifest.json")).ok();
    if destination_manifest.as_deref() != Some(source_manifest.as_slice())
        || !runtime_available(&builtin_dir)
    {
        install_directory_atomically(&source, &builtin_dir, &root)?;
    }

    let mut selection = read_selection(&root).unwrap_or_else(|| AlgorithmSelection {
        active_package_id: builtin_manifest.package_id.clone(),
        active_version: builtin_manifest.version.clone(),
        last_known_good_package_id: Some(builtin_manifest.package_id.clone()),
        last_known_good_version: Some(builtin_manifest.version.clone()),
    });
    let selected_dir = package_path_from_ids(
        &packages_root,
        &selection.active_package_id,
        &selection.active_version,
    )?;
    let selected_manifest = read_manifest(&selected_dir).ok();
    let active_dir = if selected_manifest
        .as_ref()
        .is_some_and(|manifest| installed_package_valid(manifest, &selected_dir, &builtin_manifest))
    {
        selected_dir
    } else {
        selection.active_package_id = builtin_manifest.package_id.clone();
        selection.active_version = builtin_manifest.version.clone();
        builtin_dir
    };
    write_selection(&root, &selection)?;

    let active_manifest = read_manifest(&active_dir)?;
    let mut packages = list_packages(&packages_root, &active_manifest, &builtin_manifest)?;
    packages.sort_by(|left, right| {
        right
            .active
            .cmp(&left.active)
            .then_with(|| right.release_approved.cmp(&left.release_approved))
            .then_with(|| left.display_name.cmp(&right.display_name))
    });
    let active_package = package_info(
        &active_manifest,
        &active_dir,
        true,
        active_manifest.package_id == builtin_manifest.package_id
            && active_manifest.version == builtin_manifest.version,
        installed_package_valid(&active_manifest, &active_dir, &builtin_manifest),
    );
    let last_known_good = selection
        .last_known_good_package_id
        .as_ref()
        .zip(selection.last_known_good_version.as_ref())
        .map(|(package, version)| format!("{package}@{version}"));
    Ok(AlgorithmStore {
        active_dir,
        active_package,
        packages,
        last_known_good,
    })
}

fn import_algorithm_package(app: &AppHandle, source: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err("选择的算法包不存在".to_string());
    }
    let root = algorithm_store_root(app)?;
    let import_root = root.join(format!("import-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&import_root).map_err(|error| format!("创建算法包临时目录失败: {error}"))?;
    let result = (|| {
        let extracted = if source.is_dir() {
            let destination = import_root.join("package");
            copy_dir_recursive(source, &destination)?;
            destination
        } else {
            extract_algorithm_archive(source, &import_root)?
        };
        let package_root = locate_package_root(&extracted)?;
        let manifest = read_manifest(&package_root)?;
        if !manifest_compatible(&manifest) {
            return Err(format!(
                "算法包接口不兼容：主机 API=2，包要求 {}–{}",
                manifest.host_api.minimum, manifest.host_api.maximum
            ));
        }
        verify_signature_file(&package_root)?;
        verify_checksum_file(&package_root)?;
        if !runtime_available(&package_root) {
            return Err("算法包缺少当前平台的运行程序".to_string());
        }
        let packages_root = root.join(PACKAGE_STORE_FOLDER);
        fs::create_dir_all(&packages_root)
            .map_err(|error| format!("创建算法包目录失败: {error}"))?;
        let destination = package_path(&packages_root, &manifest)?;
        if destination.exists() {
            let existing = fs::read(destination.join("SHA256SUMS.txt")).ok();
            let incoming = fs::read(package_root.join("SHA256SUMS.txt")).ok();
            if existing != incoming {
                return Err("同版本算法包已存在但内容不同；请提升算法版本后再导入".to_string());
            }
        } else {
            install_directory_atomically(&package_root, &destination, &root)?;
        }
        activate_algorithm_package(app, &manifest.package_id, &manifest.version)
    })();
    let _ = fs::remove_dir_all(&import_root);
    result
}

fn activate_algorithm_package(
    app: &AppHandle,
    package_id: &str,
    version: &str,
) -> Result<(), String> {
    let source = bundled_algorithm_source(app)?;
    let builtin = read_manifest(&source)?;
    let root = algorithm_store_root(app)?;
    let packages_root = root.join(PACKAGE_STORE_FOLDER);
    let target_dir = package_path_from_ids(&packages_root, package_id, version)?;
    let target = read_manifest(&target_dir)?;
    if !installed_package_valid(&target, &target_dir, &builtin) {
        return Err("算法包不兼容或运行程序缺失".to_string());
    }
    let previous = read_selection(&root);
    let mut last_good_id = previous
        .as_ref()
        .and_then(|value| value.last_known_good_package_id.clone());
    let mut last_good_version = previous
        .as_ref()
        .and_then(|value| value.last_known_good_version.clone());
    if let Some(previous) = previous.as_ref() {
        let previous_dir = package_path_from_ids(
            &packages_root,
            &previous.active_package_id,
            &previous.active_version,
        )?;
        if let Ok(previous_manifest) = read_manifest(&previous_dir) {
            if previous_manifest.release_approved {
                last_good_id = Some(previous_manifest.package_id);
                last_good_version = Some(previous_manifest.version);
            }
        }
    }
    if last_good_id.is_none() {
        last_good_id = Some(builtin.package_id);
        last_good_version = Some(builtin.version);
    }
    write_selection(
        &root,
        &AlgorithmSelection {
            active_package_id: target.package_id,
            active_version: target.version,
            last_known_good_package_id: last_good_id,
            last_known_good_version: last_good_version,
        },
    )
}

fn rollback_algorithm_package(app: &AppHandle) -> Result<(), String> {
    let source = bundled_algorithm_source(app)?;
    let builtin = read_manifest(&source)?;
    let root = algorithm_store_root(app)?;
    let packages_root = root.join(PACKAGE_STORE_FOLDER);
    let selection = read_selection(&root);
    let target = selection
        .as_ref()
        .and_then(|value| {
            value
                .last_known_good_package_id
                .as_ref()
                .zip(value.last_known_good_version.as_ref())
        })
        .and_then(|(package, version)| {
            package_path_from_ids(&packages_root, package, version)
                .ok()
                .filter(|path| read_manifest(path).is_ok() && runtime_available(path))
        });
    let (package_id, version) = if let Some(path) = target {
        let manifest = read_manifest(&path)?;
        (manifest.package_id, manifest.version)
    } else {
        (builtin.package_id, builtin.version)
    };
    write_selection(
        &root,
        &AlgorithmSelection {
            active_package_id: package_id.clone(),
            active_version: version.clone(),
            last_known_good_package_id: Some(package_id),
            last_known_good_version: Some(version),
        },
    )
}

fn read_manifest(directory: &Path) -> Result<AlgorithmManifest, String> {
    let path = directory.join("algorithm_manifest.json");
    let bytes =
        fs::read(&path).map_err(|error| format!("读取算法清单失败 {}: {error}", path.display()))?;
    let manifest: AlgorithmManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("算法清单格式无效 {}: {error}", path.display()))?;
    sanitize_component(&manifest.package_id)?;
    sanitize_component(&manifest.version)?;
    Ok(manifest)
}

fn manifest_compatible(manifest: &AlgorithmManifest) -> bool {
    manifest.host_api.minimum <= MAXIMUM_HOST_API
        && manifest.host_api.maximum >= MINIMUM_HOST_API
}

fn package_path(packages_root: &Path, manifest: &AlgorithmManifest) -> Result<PathBuf, String> {
    package_path_from_ids(packages_root, &manifest.package_id, &manifest.version)
}

fn package_path_from_ids(
    packages_root: &Path,
    package_id: &str,
    version: &str,
) -> Result<PathBuf, String> {
    Ok(packages_root
        .join(sanitize_component(package_id)?)
        .join(sanitize_component(version)?))
}

fn sanitize_component(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+'))
    {
        return Err("算法包标识或版本包含不安全字符".to_string());
    }
    Ok(value)
}

fn runtime_available(directory: &Path) -> bool {
    bundled_service_path(directory).is_file()
        || (directory.join("service.py").is_file() && python_path(directory).is_file())
}

fn installed_package_valid(
    manifest: &AlgorithmManifest,
    directory: &Path,
    builtin: &AlgorithmManifest,
) -> bool {
    if !manifest_compatible(manifest) || !runtime_available(directory) {
        return false;
    }
    if manifest.package_id == builtin.package_id && manifest.version == builtin.version {
        return true;
    }
    verify_signature_file(directory).is_ok() && verify_checksum_file(directory).is_ok()
}

fn package_info(
    manifest: &AlgorithmManifest,
    directory: &Path,
    active: bool,
    bundled: bool,
    compatible: bool,
) -> AlgorithmPackageInfo {
    AlgorithmPackageInfo {
        package_id: manifest.package_id.clone(),
        display_name: if manifest.display_name.trim().is_empty() {
            manifest.package_id.clone()
        } else {
            manifest.display_name.clone()
        },
        version: manifest.version.clone(),
        channel: manifest.channel.clone(),
        algorithm_profile: manifest.algorithm_profile.clone(),
        release_approved: manifest.release_approved,
        active,
        bundled,
        compatible,
        calibration_schema_version: manifest.calibration_schema_version.clone(),
        path: directory.to_string_lossy().to_string(),
    }
}

fn list_packages(
    packages_root: &Path,
    active: &AlgorithmManifest,
    builtin: &AlgorithmManifest,
) -> Result<Vec<AlgorithmPackageInfo>, String> {
    let mut output = Vec::new();
    let package_entries =
        fs::read_dir(packages_root).map_err(|error| format!("读取算法包目录失败: {error}"))?;
    for package_entry in package_entries.flatten() {
        if !package_entry.path().is_dir() {
            continue;
        }
        let Ok(version_entries) = fs::read_dir(package_entry.path()) else {
            continue;
        };
        for version_entry in version_entries.flatten() {
            let directory = version_entry.path();
            let Ok(manifest) = read_manifest(&directory) else {
                continue;
            };
            output.push(package_info(
                &manifest,
                &directory,
                manifest.package_id == active.package_id && manifest.version == active.version,
                manifest.package_id == builtin.package_id && manifest.version == builtin.version,
                installed_package_valid(&manifest, &directory, builtin),
            ));
        }
    }
    Ok(output)
}

fn read_selection(root: &Path) -> Option<AlgorithmSelection> {
    let bytes = fs::read(root.join(SELECTION_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_selection(root: &Path, selection: &AlgorithmSelection) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("创建算法目录失败: {error}"))?;
    let temporary = root.join(format!("{SELECTION_FILE}.tmp"));
    let bytes = serde_json::to_vec_pretty(selection)
        .map_err(|error| format!("编码算法选择失败: {error}"))?;
    let mut file =
        fs::File::create(&temporary).map_err(|error| format!("写入算法选择失败: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("写入算法选择失败: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步算法选择失败: {error}"))?;
    fs::rename(&temporary, root.join(SELECTION_FILE))
        .map_err(|error| format!("启用算法选择失败: {error}"))
}

fn install_directory_atomically(
    source: &Path,
    destination: &Path,
    root: &Path,
) -> Result<(), String> {
    let staging = root.join(format!("stage-{}", uuid::Uuid::new_v4()));
    copy_dir_recursive(source, &staging)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建算法版本目录失败: {error}"))?;
    }
    if destination.exists() {
        let backup = root.join(format!("backup-{}", uuid::Uuid::new_v4()));
        fs::rename(destination, &backup).map_err(|error| format!("备份旧算法包失败: {error}"))?;
        match fs::rename(&staging, destination) {
            Ok(()) => {
                let _ = fs::remove_dir_all(backup);
                Ok(())
            }
            Err(error) => {
                let _ = fs::rename(backup, destination);
                let _ = fs::remove_dir_all(staging);
                Err(format!("原子安装算法包失败: {error}"))
            }
        }
    } else {
        fs::rename(&staging, destination).map_err(|error| format!("安装算法包失败: {error}"))
    }
}

fn extract_algorithm_archive(source: &Path, destination: &Path) -> Result<PathBuf, String> {
    let file = fs::File::open(source).map_err(|error| format!("打开算法包失败: {error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("算法包不是有效 ZIP: {error}"))?;
    let extracted = destination.join("archive");
    fs::create_dir_all(&extracted).map_err(|error| format!("创建解包目录失败: {error}"))?;
    let mut total_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取算法包条目失败: {error}"))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "算法包包含不安全路径".to_string())?
            .to_path_buf();
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("算法包不允许包含符号链接".to_string());
        }
        total_bytes = total_bytes.saturating_add(entry.size());
        if total_bytes > 2 * 1024 * 1024 * 1024 {
            return Err("算法包解压后超过 2GB 限制".to_string());
        }
        let output = extracted.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| format!("创建解包目录失败: {error}"))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建解包目录失败: {error}"))?;
        }
        let mut target =
            fs::File::create(&output).map_err(|error| format!("写入算法包失败: {error}"))?;
        io::copy(&mut entry, &mut target).map_err(|error| format!("解压算法包失败: {error}"))?;
        #[cfg(unix)]
        if output.file_name().and_then(|name| name.to_str()) == Some(BUNDLED_SERVICE_EXE) {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&output)
                .map_err(|error| format!("读取运行程序权限失败: {error}"))?
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&output, permissions)
                .map_err(|error| format!("设置运行程序权限失败: {error}"))?;
        }
    }
    Ok(extracted)
}

fn locate_package_root(extracted: &Path) -> Result<PathBuf, String> {
    if extracted.join("algorithm_manifest.json").is_file() {
        return Ok(extracted.to_path_buf());
    }
    let matches: Vec<PathBuf> = fs::read_dir(extracted)
        .map_err(|error| format!("读取解包目录失败: {error}"))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join("algorithm_manifest.json").is_file())
        .collect();
    if matches.len() != 1 {
        return Err("算法包根目录必须且只能包含一个 algorithm_manifest.json".to_string());
    }
    Ok(matches[0].clone())
}

fn verify_checksum_file(root: &Path) -> Result<(), String> {
    let checksum_path = root.join("SHA256SUMS.txt");
    let text = fs::read_to_string(&checksum_path)
        .map_err(|error| format!("算法包缺少 SHA256SUMS.txt: {error}"))?;
    let mut verified = 0_usize;
    let mut listed = HashSet::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let (expected, relative) = line
            .split_once("  ")
            .ok_or_else(|| format!("校验清单第 {} 行格式无效", index + 1))?;
        if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("校验清单第 {} 行哈希无效", index + 1));
        }
        let relative_path = Path::new(relative);
        if relative_path.is_absolute()
            || relative_path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err("校验清单包含不安全路径".to_string());
        }
        let path = root.join(relative_path);
        if !listed.insert(relative_path.to_path_buf()) {
            return Err(format!("校验清单重复列出文件: {relative}"));
        }
        let actual = sha256_file(&path)?;
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(format!("算法包文件校验失败: {relative}"));
        }
        verified += 1;
    }
    if verified == 0 {
        return Err("算法包校验清单为空".to_string());
    }
    verify_no_unlisted_files(root, root, &listed)?;
    Ok(())
}

fn verify_no_unlisted_files(
    root: &Path,
    directory: &Path,
    listed: &HashSet<PathBuf>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| format!("读取算法包文件失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取算法包文件失败: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            verify_no_unlisted_files(root, &path, listed)?;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "算法包文件路径异常".to_string())?;
        if matches!(
            relative.to_str(),
            Some("SHA256SUMS.txt") | Some(ALGORITHM_SIGNATURE_FILE)
        ) {
            continue;
        }
        if !listed.contains(relative) {
            return Err(format!("算法包包含未签名文件: {}", relative.display()));
        }
    }
    Ok(())
}

fn verify_signature_file(root: &Path) -> Result<(), String> {
    verify_signature_with_key(root, &ALGORITHM_UPDATE_PUBLIC_KEY)
}

fn verify_signature_with_key(root: &Path, public_key: &[u8; 32]) -> Result<(), String> {
    let checksums = fs::read(root.join("SHA256SUMS.txt"))
        .map_err(|error| format!("读取算法包签名内容失败: {error}"))?;
    let signature_bytes = fs::read(root.join(ALGORITHM_SIGNATURE_FILE))
        .map_err(|error| format!("算法包缺少 Ed25519 签名: {error}"))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|error| format!("算法包签名格式无效: {error}"))?;
    let key = VerifyingKey::from_bytes(public_key)
        .map_err(|error| format!("内置算法更新公钥无效: {error}"))?;
    key.verify(&checksums, &signature)
        .map_err(|_| "算法包签名验证失败；包可能被篡改或并非由受信任发布者生成".to_string())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("读取校验文件失败 {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("读取校验文件失败: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
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
    use super::{
        bundled_service_path, local_url, manifest_compatible, sanitize_component, sha256_file,
        venv_python_path, verify_checksum_file, verify_signature_with_key, AlgorithmManifest,
        HostApiRange, BUNDLED_SERVICE_EXE,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use std::{fs, path::Path};

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

    #[test]
    fn rejects_path_traversal_in_package_identifiers() {
        assert!(sanitize_component("com.ifet.sleep.experimental").is_ok());
        assert!(sanitize_component("1.2.0+exp.20260824").is_ok());
        assert!(sanitize_component("../outside").is_err());
        assert!(sanitize_component("package/name").is_err());
    }

    #[test]
    fn supports_stable_api2_and_visual_metadata_api3_packages() {
        let manifest = |minimum, maximum| AlgorithmManifest {
            package_id: "com.ifet.test".into(),
            display_name: "test".into(),
            version: "1.0.0".into(),
            channel: "test".into(),
            algorithm_profile: "test".into(),
            release_approved: false,
            host_api: HostApiRange { minimum, maximum },
            calibration_schema_version: None,
        };
        assert!(manifest_compatible(&manifest(2, 2)));
        assert!(manifest_compatible(&manifest(3, 3)));
        assert!(manifest_compatible(&manifest(2, 3)));
        assert!(!manifest_compatible(&manifest(1, 1)));
        assert!(!manifest_compatible(&manifest(4, 4)));
    }

    #[test]
    fn verifies_and_detects_tampered_algorithm_files() {
        let root =
            std::env::temp_dir().join(format!("ifet-algorithm-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temporary algorithm directory");
        let payload = root.join("payload.bin");
        fs::write(&payload, b"verified").expect("write payload");
        let digest = sha256_file(&payload).expect("payload hash");
        fs::write(
            root.join("SHA256SUMS.txt"),
            format!("{digest}  payload.bin\n"),
        )
        .expect("write checksums");
        assert!(verify_checksum_file(&root).is_ok());
        fs::write(&payload, b"tampered").expect("tamper payload");
        assert!(verify_checksum_file(&root).is_err());
        fs::remove_dir_all(root).expect("remove temporary algorithm directory");
    }

    #[test]
    fn verifies_algorithm_update_signature_and_rejects_tampering() {
        let root =
            std::env::temp_dir().join(format!("ifet-signature-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temporary signature directory");
        let checksums = b"0123456789abcdef  payload.bin\n";
        fs::write(root.join("SHA256SUMS.txt"), checksums).expect("write checksum payload");
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let signature = signing_key.sign(checksums);
        fs::write(root.join("SIGNATURE.ed25519"), signature.to_bytes()).expect("write signature");
        assert!(verify_signature_with_key(&root, signing_key.verifying_key().as_bytes()).is_ok());
        fs::write(root.join("SHA256SUMS.txt"), b"tampered").expect("tamper signed payload");
        assert!(verify_signature_with_key(&root, signing_key.verifying_key().as_bytes()).is_err());
        fs::remove_dir_all(root).expect("remove temporary signature directory");
    }
}
