use serde::Serialize;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, Default)]
struct PowerReasons {
    recording: bool,
    acquisition_mode: bool,
    stimulus_receiver: bool,
}

impl PowerReasons {
    fn should_prevent_sleep(self) -> bool {
        self.recording || self.acquisition_mode || self.stimulus_receiver
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct PowerPreventionStatus {
    pub supported: bool,
    pub active: bool,
    pub recording: bool,
    pub acquisition_mode: bool,
    pub stimulus_receiver: bool,
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

    pub fn set_stimulus_receiver(&self, active: bool) -> Result<PowerPreventionStatus, String> {
        self.update(|reasons| reasons.stimulus_receiver = active)
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

        if previous.should_prevent_sleep() != next.should_prevent_sleep()
            || previous.stimulus_receiver != next.stimulus_receiver {
            inner.worker.set_active(next.should_prevent_sleep(), next.stimulus_receiver)?;
        }
        inner.reasons = next;
        Ok(snapshot(next))
    }
}

fn snapshot(reasons: PowerReasons) -> PowerPreventionStatus {
    PowerPreventionStatus {
        supported: cfg!(any(windows, target_os = "macos")),
        active: cfg!(any(windows, target_os = "macos")) && reasons.should_prevent_sleep(),
        recording: reasons.recording,
        acquisition_mode: reasons.acquisition_mode,
        stimulus_receiver: reasons.stimulus_receiver,
    }
}

#[cfg(any(windows, target_os = "macos"))]
struct PowerWorker {
    sender: std::sync::mpsc::Sender<PowerCommand>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(any(windows, target_os = "macos"))]
enum PowerCommand {
    SetActive {
        active: bool,
        display: bool,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    Shutdown,
}

#[cfg(any(windows, target_os = "macos"))]
impl PowerWorker {
    fn new() -> Self {
        let (sender, receiver) = std::sync::mpsc::channel();
        #[cfg(windows)]
        let thread = std::thread::Builder::new()
            .name("ifet-windows-sleep-prevention".to_string())
            .spawn(move || run_windows_power_worker(receiver))
            .expect("failed to create Windows sleep-prevention thread");
        #[cfg(target_os = "macos")]
        let thread = std::thread::Builder::new()
            .name("ifet-macos-background-activity".into())
            .spawn(move || run_macos_power_worker(receiver))
            .expect("failed to create macOS background-activity thread");
        Self {
            sender,
            thread: Some(thread),
        }
    }

    fn set_active(&mut self, active: bool, display: bool) -> Result<(), String> {
        let (reply, response) = std::sync::mpsc::channel();
        self.sender
            .send(PowerCommand::SetActive { active, display, reply })
            .map_err(|_| "Windows 整夜防睡眠线程已退出".to_string())?;
        response
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "Windows 整夜防睡眠请求超时".to_string())?
    }
}

#[cfg(any(windows, target_os = "macos"))]
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
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED, ES_DISPLAY_REQUIRED,
    };

    let mut active = false;
    while let Ok(command) = receiver.recv() {
        match command {
            PowerCommand::SetActive {
                active: requested,
                display,
                reply,
            } => {
                let flags = if requested {
                    ES_CONTINUOUS | ES_SYSTEM_REQUIRED | if display { ES_DISPLAY_REQUIRED } else { 0 }
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

#[cfg(target_os = "macos")]
fn run_macos_power_worker(receiver: std::sync::mpsc::Receiver<PowerCommand>) {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString, NSObjectProtocol};
    use objc2::{rc::Retained, runtime::ProtocolObject};
    let info = NSProcessInfo::processInfo();
    let mut activity: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>> = None;
    while let Ok(command) = receiver.recv() {
        match command {
            PowerCommand::SetActive { active, display, reply } => {
                let next = objc2::rc::autoreleasepool(|_| {
                    if !active { return None; }
                    let mut options = NSActivityOptions::UserInitiated | NSActivityOptions::LatencyCritical;
                    if display { options |= NSActivityOptions::IdleDisplaySleepDisabled; }
                    Some(info.beginActivityWithOptions_reason(options,
                        &NSString::from_str("iFET EEG acquisition and MATLAB stimulus event recording")))
                });
                if let Some(previous) = activity.take() {
                    // Token was created by this NSProcessInfo on this worker.
                    unsafe { info.endActivity(&previous); }
                }
                activity = next;
                let _ = reply.send(Ok(()));
            }
            PowerCommand::Shutdown => break,
        }
    }
    if let Some(previous) = activity { unsafe { info.endActivity(&previous); } }
}

#[cfg(not(any(windows, target_os = "macos")))]
struct PowerWorker;

#[cfg(not(any(windows, target_os = "macos")))]
impl PowerWorker {
    fn new() -> Self {
        Self
    }

    fn set_active(&mut self, _active: bool, _display: bool) -> Result<(), String> {
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
        reasons.stimulus_receiver = true;
        assert!(reasons.should_prevent_sleep());
    }

    #[test]
    #[cfg(any(windows, target_os = "macos"))]
    fn native_background_protection_starts_and_releases_on_the_owner_thread() {
        let state = super::PowerManagerState::default();
        assert!(state.set_recording(true).unwrap().active);
        assert!(state.set_stimulus_receiver(true).unwrap().stimulus_receiver);
        assert!(state.set_recording(false).unwrap().active);
        assert!(!state.set_stimulus_receiver(false).unwrap().active);
    }
}
