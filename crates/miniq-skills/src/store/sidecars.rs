use std::path::Path;

/// Upper bound on listed sidecar files so a huge skill pack cannot flood the
/// `skill_read` result; the model can still browse `skillDir` directly.
const MAX_SIDECAR_FILES: usize = 400;
const MAX_SIDECAR_DEPTH: usize = 6;

/// Every supporting file of a skill (relative to its directory), recursing
/// into nested folders such as `references/triage/*.md` or `rules/*.md`.
/// Hidden entries and the SKILL.md itself are skipped.
pub(super) fn list_sidecar_files(dir: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
        if depth > MAX_SIDECAR_DEPTH || out.len() >= MAX_SIDECAR_FILES {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                walk(root, &path, depth + 1, out);
            } else if kind.is_file() {
                if depth == 0 && name == "SKILL.md" {
                    continue;
                }
                if out.len() >= MAX_SIDECAR_FILES {
                    return;
                }
                let Ok(relative) = path.strip_prefix(root) else {
                    continue;
                };
                out.push(
                    relative
                        .components()
                        .map(|part| part.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/"),
                );
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, dir, 0, &mut files);
    files.sort();
    files
}
