use serde::Serialize;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, Default)]
struct PowerReasons {
    recording: bool,
    acquisition_mode: bool,
}

impl PowerReasons {
    fn should_prevent_sleep(self) -> bool {
        self.recording || self.acquisition_mode
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct PowerPreventionStatus {
    pub supported: bool,
    pub active: bool,
    pub recording: bool,
    pub acquisition_mode: bool,
}

pub struct PowerManagerState {
    inner: Mutex<PowerManagerInner>,
}

struct PowerManagerInner {
    reasons: PowerReasons,
    worker: PowerWorker,
}

impl Default for PowerManagerState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(PowerManagerInner {
                reasons: PowerReasons::default(),
                worker: PowerWorker::new(),
            }),
        }
    }
}

impl PowerManagerState {
    pub fn set_recording(&self, active: bool) -> Result<PowerPreventionStatus, String> {
        self.update(|reasons| reasons.recording = active)
    }

    pub fn set_acquisition_mode(&self, active: bool) -> Result<PowerPreventionStatus, String> {
        self.update(|reasons| reasons.acquisition_mode = active)
    }

    pub fn status(&self) -> Result<PowerPreventionStatus, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Windows 整夜防睡眠状态锁异常".to_string())?;
        Ok(snapshot(inner.reasons))
    }

    fn update(
        &self,
        update_reasons: impl FnOnce(&mut PowerReasons),
    ) -> Result<PowerPreventionStatus, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Windows 整夜防睡眠状态锁异常".to_string())?;
        let previous = inner.reasons;
        let mut next = previous;
        update_reasons(&mut next);

        if previous.should_prevent_sleep() != next.should_prevent_sleep() {
            inner.worker.set_active(next.should_prevent_sleep())?;
        }
        inner.reasons = next;
        Ok(snapshot(next))
    }
}

fn snapshot(reasons: PowerReasons) -> PowerPreventionStatus {
    PowerPreventionStatus {
        supported: cfg!(windows),
        active: cfg!(windows) && reasons.should_prevent_sleep(),
        recording: reasons.recording,
        acquisition_mode: reasons.acquisition_mode,
    }
}

#[cfg(windows)]
struct PowerWorker {
    sender: std::sync::mpsc::Sender<PowerCommand>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(windows)]
enum PowerCommand {
    SetActive {
        active: bool,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    Shutdown,
}

#[cfg(windows)]
impl PowerWorker {
    fn new() -> Self {
        let (sender, receiver) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("ifet-windows-sleep-prevention".to_string())
            .spawn(move || run_windows_power_worker(receiver))
            .expect("failed to create Windows sleep-prevention thread");
        Self {
            sender,
            thread: Some(thread),
        }
    }

    fn set_active(&self, active: bool) -> Result<(), String> {
        let (reply, response) = std::sync::mpsc::channel();
        self.sender
            .send(PowerCommand::SetActive { active, reply })
            .map_err(|_| "Windows 整夜防睡眠线程已退出".to_string())?;
        response
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "Windows 整夜防睡眠请求超时".to_string())?
    }
}

#[cfg(windows)]
impl Drop for PowerWorker {
    fn drop(&mut self) {
        let _ = self.sender.send(PowerCommand::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(windows)]
fn run_windows_power_worker(receiver: std::sync::mpsc::Receiver<PowerCommand>) {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    let mut active = false;
    while let Ok(command) = receiver.recv() {
        match command {
            PowerCommand::SetActive {
                active: requested,
                reply,
            } => {
                let flags = if requested {
                    ES_CONTINUOUS | ES_SYSTEM_REQUIRED
                } else {
                    ES_CONTINUOUS
                };
                let result = unsafe { SetThreadExecutionState(flags) };
                let response = if result == 0 {
                    Err(format!(
                        "Windows 整夜防睡眠请求失败: {}",
                        std::io::Error::last_os_error()
                    ))
                } else {
                    active = requested;
                    Ok(())
                };
                let _ = reply.send(response);
            }
            PowerCommand::Shutdown => break,
        }
    }

    if active {
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}

#[cfg(not(windows))]
struct PowerWorker;

#[cfg(not(windows))]
impl PowerWorker {
    fn new() -> Self {
        Self
    }

    fn set_active(&self, _active: bool) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::PowerReasons;

    #[test]
    fn recording_and_acquisition_mode_are_independent_sleep_prevention_reasons() {
        let mut reasons = PowerReasons::default();
        assert!(!reasons.should_prevent_sleep());

        reasons.recording = true;
        assert!(reasons.should_prevent_sleep());

        reasons.acquisition_mode = true;
        reasons.recording = false;
        assert!(reasons.should_prevent_sleep());

        reasons.acquisition_mode = false;
        assert!(!reasons.should_prevent_sleep());
    }
}
