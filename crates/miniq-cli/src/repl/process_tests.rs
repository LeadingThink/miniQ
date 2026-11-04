use super::*;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn output_streams_before_exit_and_cancellation_stops_descendants() {
    let directory = tempfile::tempdir().unwrap();
    let mut processes = Processes::default();
    #[cfg(windows)]
    let (program, args) = ("powershell.exe", vec!["-NoProfile", "-Command",
        "& powershell.exe -NoProfile -Command '[Console]::WriteLine($PID); Start-Sleep -Seconds 30'"]);
    #[cfg(unix)]
    let (program, args) = ("sh", vec!["-c", "sh -c 'echo $$; sleep 30'"]);
    processes.start(
        "s",
        "long command",
        program.into(),
        args.into_iter().map(Into::into).collect(),
        directory.path().into(),
    );
    let event = tokio::time::timeout(Duration::from_secs(10), processes.next())
        .await
        .unwrap();
    let Event::Output(id, output) = event else {
        panic!("expected output while process runs");
    };
    let descendant: u32 = output.trim().parse().unwrap();
    assert!(processes.active("s").is_some());
    #[cfg(windows)]
    let handle = {
        use std::os::windows::io::FromRawHandle;
        let handle = unsafe {
            windows_sys::Win32::System::Threading::OpenProcess(0x00100000, 0, descendant)
        };
        assert!(!handle.is_null());
        unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) }
    };
    #[cfg(unix)]
    assert!(descendant > 0);
    processes.cancel_id(id);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Event::Done(done, result) = processes.next().await {
                assert_eq!(done, id);
                assert_eq!(result.unwrap(), "Interrupted local command");
                break;
            }
        }
    })
    .await
    .unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        assert_eq!(
            unsafe {
                windows_sys::Win32::System::Threading::WaitForSingleObject(
                    handle.as_raw_handle(),
                    5000,
                )
            },
            0
        );
    }
}

#[tokio::test]
async fn streaming_preserves_utf8_split_between_reads_and_all_output() {
    let (mut writer, reader) = tokio::io::duplex(8);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(pump(1, reader, tx));
    let expected = "中文 👩‍💻\ncomplete output\n".repeat(500);
    let bytes = expected.as_bytes().to_vec();
    let producer = tokio::spawn(async move {
        for byte in bytes {
            writer.write_all(&[byte]).await.unwrap();
        }
    });
    let mut actual = String::new();
    while let Some(Event::Output(_, text)) = rx.recv().await {
        actual.push_str(&text);
    }
    producer.await.unwrap();
    task.await.unwrap().unwrap();
    assert_eq!(actual, expected);
}
