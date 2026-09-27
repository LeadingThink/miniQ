//! Embeds the bundled (first-party) plugin packages under `bundled/` into the
//! binary. Each package is `bundled/<plugin-id>/...`; the daemon materializes
//! them into the plugin directory on startup.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect(root, &path, out);
        } else if kind.is_file() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .expect("bundled file is under the bundled root")
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((relative, path));
        }
    }
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest_dir.join("bundled");
    println!("cargo:rerun-if-changed=bundled");
    let mut files = Vec::new();
    collect(&root, &root, &mut files);
    files.sort();
    let mut source = String::from("pub(crate) static BUNDLED_FILES: &[(&str, &str)] = &[\n");
    for (relative, path) in files {
        let absolute = path.canonicalize().unwrap_or(path);
        writeln!(
            source,
            "    ({relative:?}, include_str!({:?})),",
            absolute.to_string_lossy()
        )
        .unwrap();
    }
    source.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("bundled_plugins.rs");
    std::fs::write(out, source).unwrap();
}
