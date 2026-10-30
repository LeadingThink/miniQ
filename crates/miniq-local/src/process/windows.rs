use super::{validate_pid, ProcessIdentity};
use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use windows_sys::Win32::{
    Foundation::{ERROR_INVALID_PARAMETER, FILETIME, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        GetProcessId, GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    },
};

pub(super) struct Process(OwnedHandle);

impl Process {
    pub fn open(pid: u32) -> io::Result<Option<Self>> {
        Self::with_access(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)
    }

    fn with_access(pid: u32, access: u32) -> io::Result<Option<Self>> {
        validate_pid(pid)?;
        let raw = unsafe { OpenProcess(access, 0, pid) };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        Ok(Some(Self(unsafe { OwnedHandle::from_raw_handle(raw) })))
    }

    pub fn identity(&self) -> io::Result<ProcessIdentity> {
        let mut created: FILETIME = unsafe { std::mem::zeroed() };
        let (mut exited, mut kernel, mut user) = (created, created, created);
        if unsafe {
            GetProcessTimes(
                self.0.as_raw_handle(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(ProcessIdentity::Windows {
            created_at: (u64::from(created.dwHighDateTime) << 32)
                | u64::from(created.dwLowDateTime),
        })
    }

    pub fn is_running(&self) -> io::Result<bool> {
        match unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) } {
            WAIT_TIMEOUT => Ok(true),
            WAIT_OBJECT_0 => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }

    pub fn terminate(&self, expected: &ProcessIdentity) -> io::Result<()> {
        if !self.is_running()? {
            return Ok(());
        }
        let pid = unsafe { GetProcessId(self.0.as_raw_handle()) };
        let Some(target) = Self::with_access(
            pid,
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
        )?
        else {
            return Ok(());
        };
        // Retain the observation handle and verify the handle granted termination rights.
        if target.identity()? != *expected || !target.is_running()? {
            return Ok(());
        }
        if unsafe { TerminateProcess(target.0.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
