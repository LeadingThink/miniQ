use super::{validate_pid, ProcessIdentity};
use std::io;

pub(super) struct Process {
    pid: u32,
    #[cfg(target_os = "linux")]
    handle: std::os::fd::OwnedFd,
}

impl Process {
    pub fn open(pid: u32) -> io::Result<Option<Self>> {
        validate_pid(pid)?;
        #[cfg(target_os = "linux")]
        let handle = {
            use std::os::fd::FromRawFd;
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
            if fd < 0 {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(None)
                } else {
                    Err(error)
                };
            }
            unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) }
        };
        match details(pid) {
            Ok(_) => Ok(Some(Self {
                pid,
                #[cfg(target_os = "linux")]
                handle,
            })),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn identity(&self) -> io::Result<ProcessIdentity> {
        Ok(details(self.pid)?.1)
    }

    pub fn is_running(&self) -> io::Result<bool> {
        // Child ownership belongs to the launcher. Observers must not steal its exit status.
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let mut descriptor = libc::pollfd {
                fd: self.handle.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let result = unsafe { libc::poll(&mut descriptor, 1, 0) };
            if result < 0 {
                return Err(io::Error::last_os_error());
            }
            if result > 0 {
                return Ok(false);
            }
        }
        match details(self.pid) {
            Ok((zombie, _)) => Ok(!zombie),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub fn terminate(&self, expected: &ProcessIdentity) -> io::Result<()> {
        // Revalidate immediately before signalling; a stale record never authorizes a kill.
        match details(self.pid) {
            Ok((false, identity)) if identity == *expected => {}
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        }
        #[cfg(target_os = "linux")]
        let result = {
            use std::os::fd::AsRawFd;
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    self.handle.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            }
        };
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::kill(self.pid as i32, libc::SIGKILL) };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn details(pid: u32) -> io::Result<(bool, ProcessIdentity)> {
    let stat = std::fs::read(format!("/proc/{pid}/stat"))?;
    let (zombie, start_ticks) = parse_stat(&stat)?;
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?
        .trim()
        .to_owned();
    if boot_id.is_empty() {
        return Err(io::Error::other("empty Linux boot ID"));
    }
    Ok((
        zombie,
        ProcessIdentity::Linux {
            boot_id,
            start_ticks,
        },
    ))
}

#[cfg(any(target_os = "linux", test))]
fn parse_stat(stat: &[u8]) -> io::Result<(bool, u64)> {
    // comm may contain closing parentheses, spaces and non-UTF8 bytes.
    let end = stat
        .iter()
        .rposition(|byte| *byte == b')')
        .ok_or_else(|| io::Error::other("invalid process stat"))?;
    let fields = std::str::from_utf8(&stat[end + 1..]).map_err(io::Error::other)?;
    let mut fields = fields.split_whitespace();
    let zombie = fields.next() == Some("Z");
    let start_ticks = fields
        .nth(18)
        .ok_or_else(|| io::Error::other("missing process start time"))?
        .parse()
        .map_err(io::Error::other)?;
    Ok((zombie, start_ticks))
}

#[cfg(test)]
#[test]
fn parses_process_state_after_full_comm_field() {
    let mut stat = b"1 (a ) \xff name) S ".to_vec();
    for field in 4..=21 {
        stat.extend_from_slice(format!("{field} ").as_bytes());
    }
    stat.extend_from_slice(b"123456 0 0");
    assert_eq!(parse_stat(&stat).unwrap(), (false, 123456));
    assert!(parse_stat(b"1 (invalid) Z 0").is_err());
}

#[cfg(target_os = "macos")]
fn details(pid: u32) -> io::Result<(bool, ProcessIdentity)> {
    let unique_id = unique_id(pid)?;
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            1,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if read <= 0 {
        return Err(process_error());
    }
    if read != size {
        return Err(io::Error::other("incomplete process identity"));
    }
    let info = unsafe { info.assume_init() };
    if unique_id != self::unique_id(pid)? {
        return Err(io::Error::other("process identity changed"));
    }
    let mut boot = [0u8; 37];
    let mut length = boot.len();
    if unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            boot.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if length != boot.len() {
        return Err(io::Error::other("incomplete macOS boot ID"));
    }
    let boot_id = std::ffi::CStr::from_bytes_with_nul(&boot)
        .map_err(io::Error::other)?
        .to_str()
        .map_err(io::Error::other)?
        .to_owned();
    Ok((
        info.pbi_status == libc::SZOMB,
        ProcessIdentity::MacOs {
            boot_id,
            unique_id,
            start_seconds: info.pbi_start_tvsec,
            start_microseconds: info.pbi_start_tvusec,
        },
    ))
}

#[cfg(target_os = "macos")]
fn unique_id(pid: u32) -> io::Result<u64> {
    #[repr(C)]
    struct UniqueInfo {
        uuid: [u8; 16],
        id: u64,
        parent: u64,
        reserved: [u64; 3],
    }
    let mut info = std::mem::MaybeUninit::<UniqueInfo>::uninit();
    let size = std::mem::size_of::<UniqueInfo>() as i32;
    let read = unsafe { libc::proc_pidinfo(pid as i32, 17, 1, info.as_mut_ptr().cast(), size) };
    if read <= 0 {
        return Err(process_error());
    }
    if read != size {
        return Err(io::Error::other("incomplete unique process identity"));
    }
    Ok(unsafe { info.assume_init() }.id)
}

#[cfg(target_os = "macos")]
fn process_error() -> io::Error {
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        io::Error::from(io::ErrorKind::NotFound)
    } else {
        error
    }
}
