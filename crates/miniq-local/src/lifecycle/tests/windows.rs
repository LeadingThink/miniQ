use super::*;

pub(super) fn deny_access(access: u32) {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            SetKernelObjectSecurity, DACL_SECURITY_INFORMATION,
        },
        System::Threading::GetCurrentProcess,
    };
    // This runs only inside the isolated fixture. Its creator's existing Child handle
    // retains termination rights for cleanup; future PROCESS_TERMINATE opens are denied.
    let sddl: Vec<u16> = format!("D:(D;;0x{access:04x};;;WD)(A;;GA;;;WD)")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = std::ptr::null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        },
        0
    );
    let changed = unsafe {
        SetKernelObjectSecurity(GetCurrentProcess(), DACL_SECURITY_INFORMATION, descriptor)
    };
    unsafe {
        LocalFree(descriptor);
    }
    assert_ne!(changed, 0);
}

struct WithoutDebugPrivilege;

impl WithoutDebugPrivilege {
    fn new() -> Self {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            Security::{
                AdjustTokenPrivileges, ImpersonateSelf, LookupPrivilegeValueW,
                SecurityImpersonation, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
            },
            System::Threading::{GetCurrentThread, OpenThreadToken},
        };
        // CI or a developer shell can have SeDebugPrivilege enabled, bypassing the DACL.
        // Disable it on this blocking worker's impersonation token only, never process-wide.
        assert_ne!(unsafe { ImpersonateSelf(SecurityImpersonation) }, 0);
        let guard = Self;
        let mut token = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                OpenThreadToken(
                    GetCurrentThread(),
                    TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
                    0,
                    &mut token,
                )
            },
            0
        );
        let mut privileges: TOKEN_PRIVILEGES = unsafe { std::mem::zeroed() };
        let name: Vec<u16> = "SeDebugPrivilege".encode_utf16().chain(Some(0)).collect();
        let found = unsafe {
            LookupPrivilegeValueW(
                std::ptr::null(),
                name.as_ptr(),
                &mut privileges.Privileges[0].Luid,
            )
        };
        privileges.PrivilegeCount = 1;
        let changed = unsafe {
            AdjustTokenPrivileges(
                token,
                0,
                &privileges,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        unsafe {
            CloseHandle(token);
        }
        assert_ne!(found, 0);
        assert_ne!(changed, 0);
        guard
    }
}

impl Drop for WithoutDebugPrivilege {
    fn drop(&mut self) {
        assert_ne!(unsafe { windows_sys::Win32::Security::RevertToSelf() }, 0);
    }
}

#[tokio::test]
async fn observation_succeeds_without_termination_rights_and_stop_reports_denial() {
    let fixture = Fixture::new();
    let mut launch =
        launch::Launch::start(fixture.path(), command("deny-terminate").unwrap()).unwrap();
    let info = fixture.record().await;
    let result = tokio::task::spawn_blocking(move || {
        let _privileges = WithoutDebugPrivilege::new();
        let process = DaemonProcess::open(info.pid, &info.process_identity)
            .unwrap()
            .unwrap();
        assert!(process.is_running().unwrap());
        process.stop(Duration::ZERO)
    })
    .await
    .unwrap();
    // Always clean up through the original child handle before asserting results.
    launch.cancel().await.unwrap();
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
}

#[tokio::test]
async fn query_denial_does_not_mean_process_is_absent() {
    let fixture = Fixture::new();
    let mut launch = launch::Launch::start(fixture.path(), command("deny-query").unwrap()).unwrap();
    let info = fixture.record().await;
    let result = tokio::task::spawn_blocking(move || {
        let _privileges = WithoutDebugPrivilege::new();
        DaemonProcess::open(info.pid, &info.process_identity)
            .err()
            .map(|error| error.kind())
    })
    .await
    .unwrap();
    launch.cancel().await.unwrap();
    assert_eq!(result, Some(io::ErrorKind::PermissionDenied));
}
