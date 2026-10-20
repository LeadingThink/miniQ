use std::{fs::File, io};

pub(super) fn ensure_single_link(file: &File) -> io::Result<()> {
    if count(file)? == 1 {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "不能通过硬链接授权文件",
        ))
    }
}

#[cfg(unix)]
fn count(file: &File) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink())
}

#[cfg(windows)]
fn count(file: &File) -> io::Result<u64> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)]
    #[derive(Default)]
    struct StandardInfo {
        allocation_size: i64,
        end_of_file: i64,
        number_of_links: u32,
        delete_pending: u8,
        directory: u8,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(
            handle: *mut c_void,
            class: i32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
    }
    let mut info = StandardInfo::default();
    // SAFETY: the owned handle is live, FileStandardInfo is class 1, and the
    // output has the platform's FILE_STANDARD_INFO layout and complete size.
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            1,
            (&mut info as *mut StandardInfo).cast(),
            std::mem::size_of::<StandardInfo>() as u32,
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(info.number_of_links.into())
    }
}
