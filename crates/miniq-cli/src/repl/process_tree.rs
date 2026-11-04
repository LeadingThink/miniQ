//! Own only the local command's process tree, including children holding output pipes.
use anyhow::Result;

#[cfg(windows)]
pub struct Tree(std::os::windows::io::OwnedHandle);
#[cfg(unix)]
pub struct Tree(u32);

impl Tree {
    #[cfg(windows)]
    pub fn new(pid: u32) -> Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::{JobObjects::*, Threading::*};
        // Owned handles close on every error path. A private job never includes the daemon.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            anyhow::ensure!(!job.is_null(), "{}", std::io::Error::last_os_error());
            let job = OwnedHandle::from_raw_handle(job);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            anyhow::ensure!(
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&info) as u32
                ) != 0,
                "{}",
                std::io::Error::last_os_error()
            );
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            anyhow::ensure!(!process.is_null(), "{}", std::io::Error::last_os_error());
            let process = OwnedHandle::from_raw_handle(process);
            anyhow::ensure!(
                AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) != 0,
                "{}",
                std::io::Error::last_os_error()
            );
            Ok(Self(job))
        }
    }

    #[cfg(unix)]
    pub fn new(pid: u32) -> Result<Self> {
        Ok(Self(pid))
    }

    #[cfg(windows)]
    pub async fn kill(&self) -> Result<()> {
        use std::os::windows::io::AsRawHandle;
        let result = unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0.as_raw_handle(), 1)
        };
        anyhow::ensure!(result != 0, "{}", std::io::Error::last_os_error());
        Ok(())
    }

    #[cfg(unix)]
    pub async fn kill(&self) -> Result<()> {
        let output = tokio::process::Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", self.0)])
            .output()
            .await?;
        anyhow::ensure!(
            output.status.success(),
            "Could not interrupt command: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    }
}
