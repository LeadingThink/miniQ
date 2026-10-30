use std::{
    fs::File,
    io::{self, Write},
    os::windows::process::CommandExt,
    process::Command,
};
use windows_sys::Win32::System::{
    JobObjects::{
        IsProcessInJob, JobObjectExtendedLimitInformation, QueryInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    },
    Threading::{GetCurrentProcess, CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, DETACHED_PROCESS},
};

pub(super) fn detach(command: &mut Command, log: &mut File) -> io::Result<()> {
    let mut flags = CREATE_NO_WINDOW | DETACHED_PROCESS;
    let mut in_job = 0;
    if unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if in_job != 0 {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(
                std::ptr::null_mut(),
                JobObjectExtendedLimitInformation,
                (&mut info as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let limits = info.BasicLimitInformation.LimitFlags;
        if limits & JOB_OBJECT_LIMIT_BREAKAWAY_OK != 0 {
            flags |= CREATE_BREAKAWAY_FROM_JOB;
        } else if limits & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK == 0 {
            // A restricted terminal/IDE job cannot be escaped. Preserve launch support and
            // record that its owner can end this daemon; do not retry a failed CreateProcess.
            writeln!(log, "[miniq] Host Job Object does not permit breakaway; daemon lifetime remains subject to that host.")?;
        }
    }
    command.creation_flags(flags);
    Ok(())
}
