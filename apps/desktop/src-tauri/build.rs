fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_apple_speech();
    }
    tauri_build::build()
}

fn build_apple_speech() {
    use std::{env, path::PathBuf, process::Command};
    println!("cargo:rerun-if-changed=native/AppleSpeech.swift");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        _ => panic!("unsupported macOS architecture"),
    };
    let deployment = env::var("MACOSX_DEPLOYMENT_TARGET")
        .unwrap_or_else(|_| if arch == "arm64" { "11.0" } else { "10.13" }.into());
    let target = format!("{arch}-apple-macosx{deployment}");
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-swift-version",
            "5",
            "-parse-as-library",
            "-emit-library",
            "-static",
            "-module-name",
            "MiniqAppleSpeech",
            "-target",
            &target,
            "native/AppleSpeech.swift",
            "-o",
        ])
        .arg(out.join("libminiq_apple_speech.a"))
        .status()
        .expect("Swift compiler is required for macOS speech");
    assert!(status.success(), "Apple speech bridge compilation failed");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=miniq_apple_speech");
    // Swift's autolink directives need its toolchain libraries at the final Rust link.
    let output = Command::new("xcrun")
        .args(["--find", "swiftc"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let compiler = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
    let libraries = compiler
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("lib/swift/macosx");
    println!("cargo:rustc-link-search=native={}", libraries.display());
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    // Speech was introduced after the oldest supported Intel macOS. Swift
    // availability guards return false there; keep the framework optional.
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,Speech");
    for framework in ["AVFoundation", "Foundation"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}
