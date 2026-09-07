use std::time::Duration;

pub struct DaemonProcess {
    pid: u32,
    #[cfg(windows)]
    handle: Option<std::os::windows::io::OwnedHandle>,
}

impl DaemonProcess {
    pub fn open(pid: u32) -> Result<Self, String> {
        if pid == 0 || pid > i32::MAX as u32 {
            return Err("invalid daemon process id".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::FromRawHandle;
            use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};

            let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            let handle = if raw.is_null() {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_INVALID_PARAMETER as i32) {
                    return Err(format!("cannot observe daemon process {pid}: {error}"));
                }
                None
            } else {
                Some(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) })
            };
            Ok(Self { pid, handle })
        }
        #[cfg(unix)]
        {
            Ok(Self { pid })
        }
    }

    pub fn wait(&self, timeout: Duration) -> Result<(), String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
            use windows_sys::Win32::System::Threading::WaitForSingleObject;

            let Some(handle) = &self.handle else {
                return Ok(());
            };
            let millis = u32::try_from(timeout.as_millis()).map_err(|e| e.to_string())?;
            match unsafe { WaitForSingleObject(handle.as_raw_handle(), millis) } {
                WAIT_OBJECT_0 => return Ok(()),
                WAIT_TIMEOUT => {}
                _ => {
                    return Err(format!(
                        "cannot wait for daemon process {}: {}",
                        self.pid,
                        std::io::Error::last_os_error()
                    ))
                }
            }
        }
        #[cfg(unix)]
        {
            let deadline = std::time::Instant::now() + timeout;
            loop {
                if unsafe { libc::waitpid(self.pid as i32, std::ptr::null_mut(), libc::WNOHANG) }
                    == self.pid as i32
                {
                    return Ok(());
                }
                if unsafe { libc::kill(self.pid as i32, 0) } != 0 {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() == Some(libc::ESRCH) {
                        return Ok(());
                    }
                    return Err(format!(
                        "cannot observe daemon process {}: {error}",
                        self.pid
                    ));
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        Err(format!(
            "daemon process {} did not exit within {} seconds",
            self.pid,
            timeout.as_secs()
        ))
    }
}

#[cfg(test)]
mod tests;
