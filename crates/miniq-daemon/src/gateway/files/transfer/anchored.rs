//! Directory-relative operations keep mutable path components out of writes.
use std::{
    fs::{File, OpenOptions},
    io,
    path::{Component, Path, PathBuf},
};

pub(super) struct Directory {
    file: File,
    path: PathBuf,
    // Windows denies directory deletion while these handles remain open.
    #[cfg(not(unix))]
    _parents: Vec<File>,
}

impl Directory {
    pub(super) fn open(path: &Path) -> io::Result<Self> {
        let mut directory = Self::root(path)?;
        for component in path.components() {
            match component {
                Component::Normal(name) => {
                    directory = directory.child(name.to_str().ok_or_else(invalid)?, false)?;
                }
                Component::RootDir | Component::Prefix(_) => {}
                _ => return Err(invalid()),
            }
        }
        Ok(directory)
    }

    fn root(path: &Path) -> io::Result<Self> {
        let root: PathBuf = path
            .components()
            .take_while(|c| !matches!(c, Component::Normal(_)))
            .collect();
        let file = platform::open_directory(&root)?;
        Ok(Self {
            file,
            path: root,
            #[cfg(not(unix))]
            _parents: vec![],
        })
    }

    pub(super) fn child(&self, name: &str, create: bool) -> io::Result<Self> {
        if create {
            match platform::mkdir(self, name) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
        self.open_child(name)
    }

    pub(super) fn create_unique(&self, name: &str) -> io::Result<Self> {
        platform::mkdir(self, name)?;
        self.open_child(name)
    }

    fn open_child(&self, name: &str) -> io::Result<Self> {
        let file = platform::child_directory(self, name)?;
        #[cfg(not(unix))]
        let mut parents = self
            ._parents
            .iter()
            .map(File::try_clone)
            .collect::<io::Result<Vec<_>>>()?;
        #[cfg(not(unix))]
        parents.push(self.file.try_clone()?);
        Ok(Self {
            file,
            path: self.path.join(name),
            #[cfg(not(unix))]
            _parents: parents,
        })
    }

    pub(super) fn create_file(&self, name: &str) -> io::Result<File> {
        platform::file(self, name, true)
    }
    pub(super) fn remove_file(&self, name: &str) -> io::Result<()> {
        platform::remove(self, name, false)
    }
    pub(super) fn remove_dir(&self, name: &str) -> io::Result<()> {
        platform::remove(self, name, true)
    }
    pub(super) fn publish(&self, from: &str, to: &str) -> io::Result<()> {
        platform::link(self, from, to)
    }
    pub(super) fn verify_path(&self) -> io::Result<()> {
        let current = Self::open(&self.path)?;
        platform::same_directory(&self.file, &current.file)
    }
}

pub(super) fn open_file(path: &Path) -> io::Result<File> {
    let parent = Directory::open(path.parent().ok_or_else(invalid)?)?;
    platform::file(
        &parent,
        path.file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(invalid)?,
        false,
    )
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "unsafe transfer path")
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
    };
    // These are the native ABI flags on the supported Unix targets.
    #[cfg(target_os = "macos")]
    const FLAGS: (i32, i32, i32, i32, i32) = (0x100, 0x100000, 0x1000000, 0x200, 0x800);
    #[cfg(not(target_os = "macos"))]
    const FLAGS: (i32, i32, i32, i32, i32) = (0x20000, 0x10000, 0x80000, 0x40, 0x80);
    const NOFOLLOW: i32 = FLAGS.0;
    const DIRECTORY: i32 = FLAGS.1;
    const CLOEXEC: i32 = FLAGS.2;
    unsafe extern "C" {
        fn openat(fd: i32, path: *const std::ffi::c_char, flags: i32, ...) -> i32;
        fn mkdirat(fd: i32, path: *const std::ffi::c_char, mode: u32) -> i32;
        fn unlinkat(fd: i32, path: *const std::ffi::c_char, flags: i32) -> i32;
        fn linkat(
            fd: i32,
            path: *const std::ffi::c_char,
            newfd: i32,
            newpath: *const std::ffi::c_char,
            flags: i32,
        ) -> i32;
    }
    fn name(value: &str) -> io::Result<CString> {
        CString::new(value).map_err(|_| invalid())
    }
    fn result(value: i32) -> io::Result<()> {
        if value == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    fn open(dir: &Directory, value: &str, flags: i32) -> io::Result<File> {
        let value = name(value)?;
        // SAFETY: the fd is live, the CString is terminated, and mode is supplied for O_CREAT.
        let fd = unsafe {
            openat(
                dir.file.as_raw_fd(),
                value.as_ptr(),
                flags | NOFOLLOW | CLOEXEC,
                0o600u32,
            )
        };
        result(fd)?;
        // SAFETY: successful openat returned a new, owned descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub(super) fn open_directory(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW | DIRECTORY | CLOEXEC)
            .open(path)
    }
    pub(super) fn child_directory(dir: &Directory, value: &str) -> io::Result<File> {
        open(dir, value, DIRECTORY)
    }
    pub(super) fn file(dir: &Directory, value: &str, create: bool) -> io::Result<File> {
        // O_NONBLOCK prevents a concurrently substituted FIFO from hanging a read.
        #[cfg(target_os = "macos")]
        let nonblock = 0x4;
        #[cfg(not(target_os = "macos"))]
        let nonblock = 0x800;
        open(
            dir,
            value,
            if create {
                2 | FLAGS.3 | FLAGS.4
            } else {
                nonblock
            },
        )
    }
    pub(super) fn mkdir(dir: &Directory, value: &str) -> io::Result<()> {
        let value = name(value)?;
        // SAFETY: both arguments refer to live values; mkdirat creates only this child.
        result(unsafe { mkdirat(dir.file.as_raw_fd(), value.as_ptr(), 0o700) })
    }
    pub(super) fn remove(dir: &Directory, value: &str, directory: bool) -> io::Result<()> {
        let value = name(value)?;
        #[cfg(target_os = "macos")]
        let removedir = 0x80;
        #[cfg(not(target_os = "macos"))]
        let removedir = 0x200;
        // SAFETY: the live directory handle anchors a single, terminated child name.
        result(unsafe {
            unlinkat(
                dir.file.as_raw_fd(),
                value.as_ptr(),
                if directory { removedir } else { 0 },
            )
        })
    }
    pub(super) fn link(dir: &Directory, from: &str, to: &str) -> io::Result<()> {
        let (from, to) = (name(from)?, name(to)?);
        // SAFETY: live handles and CStrings; linkat without flags never overwrites.
        result(unsafe {
            linkat(
                dir.file.as_raw_fd(),
                from.as_ptr(),
                dir.file.as_raw_fd(),
                to.as_ptr(),
                0,
            )
        })
    }
    pub(super) fn same_directory(first: &File, second: &File) -> io::Result<()> {
        let (a, b) = (first.metadata()?, second.metadata()?);
        if a.dev() == b.dev() && a.ino() == b.ino() {
            Ok(())
        } else {
            Err(invalid())
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    pub(super) fn open_directory(path: &Path) -> io::Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .share_mode(3)
            .custom_flags(0x02000000 | 0x00200000)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
            return Err(invalid());
        }
        Ok(file)
    }
    pub(super) fn child_directory(dir: &Directory, name: &str) -> io::Result<File> {
        open_directory(&dir.path.join(name))
    }
    pub(super) fn file(dir: &Directory, name: &str, create: bool) -> io::Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .write(create)
            .create_new(create)
            .custom_flags(0x00200000)
            .open(dir.path.join(name))?;
        if file.metadata()?.file_attributes() & 0x400 != 0 {
            return Err(invalid());
        }
        Ok(file)
    }
    pub(super) fn mkdir(dir: &Directory, name: &str) -> io::Result<()> {
        std::fs::create_dir(dir.path.join(name))
    }
    pub(super) fn remove(dir: &Directory, name: &str, directory: bool) -> io::Result<()> {
        if directory {
            std::fs::remove_dir(dir.path.join(name))
        } else {
            std::fs::remove_file(dir.path.join(name))
        }
    }
    pub(super) fn link(dir: &Directory, from: &str, to: &str) -> io::Result<()> {
        std::fs::hard_link(dir.path.join(from), dir.path.join(to))
    }
    pub(super) fn same_directory(_: &File, _: &File) -> io::Result<()> {
        Ok(())
    } // Handles deny rename/delete.
}
