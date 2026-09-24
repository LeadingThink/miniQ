use std::process::Command;

#[test]
fn version_and_help_never_start_or_modify_a_daemon() {
    let directory = tempfile::tempdir().unwrap();
    for flag in ["--version", "-V", "--help", "-h", "--invalid"] {
        let output = Command::new(env!("CARGO_BIN_EXE_miniq-daemon"))
            .arg(flag)
            .env("MINIQ_DATA_DIR", directory.path())
            .output()
            .unwrap();
        assert_eq!(output.status.success(), flag != "--invalid");
        assert_eq!(directory.path().read_dir().unwrap().count(), 0);
        if flag == "--version" {
            assert!(String::from_utf8(output.stdout)
                .unwrap()
                .contains(env!("CARGO_PKG_VERSION")));
        }
    }
}
