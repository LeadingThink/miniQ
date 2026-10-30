use super::*;
use std::{path::Path, sync::Arc, time::Duration};

async fn run_git(cwd: &PathBuf, args: &[&str]) -> Vec<u8> {
    let mut command = git(cwd);
    command.args(args);
    ensure_success(output(command).await.unwrap()).unwrap()
}

async fn repository() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap();
    run_git(&path, &["init", "--quiet"]).await;
    (directory, path)
}

fn state_for(path: &Path) -> (AppState, String) {
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(path.to_str().unwrap(), "git")
        .unwrap();
    let session = store.create_session(&workspace.id, "git").unwrap();
    let state = AppState::new(
        store,
        "test".into(),
        Arc::new(miniq_models::mock::MockProvider::new(vec![])),
    );
    (state, session.id)
}

#[test]
fn parses_branch_changes_and_renames() {
    let (branch, entries) =
        parse_status(b"## main...origin/main\0 M src/a.rs\0R  new.rs\0old.rs\0?? note.txt\0")
            .unwrap();
    assert_eq!(branch.as_deref(), Some("main...origin/main"));
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].path, "src/a.rs");
    assert_eq!(entries[1].original_path.as_deref(), Some("old.rs"));
    assert_eq!(entries[2].index_status, '?');
}

#[test]
fn sums_numstat_and_keeps_per_file_counts() {
    let (stats, map) =
        parse_numstat_map(b"12\t3\tsrc/a.rs\0-\t-\tlogo.png\04\t0\tnew.txt\0").unwrap();
    assert_eq!(stats.additions, 16);
    assert_eq!(stats.deletions, 3);
    assert_eq!(map.get("src/a.rs"), Some(&(12, 3)));
    assert_eq!(map.get("new.txt"), Some(&(4, 0)));
    assert!(!map.contains_key("logo.png"));
}

#[test]
fn parses_name_status_entries_including_renames() {
    let entries = parse_name_status(b"M\0src/a.rs\0R100\0old.rs\0new.rs\0D\0gone.txt\0").unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].path, "src/a.rs");
    assert_eq!(entries[0].index_status, 'M');
    assert_eq!(entries[1].original_path.as_deref(), Some("old.rs"));
    assert_eq!(entries[1].path, "new.rs");
    assert_eq!(entries[2].index_status, 'D');
}

#[tokio::test]
async fn batched_untracked_counts_match_git_without_creating_the_real_index() {
    let (_directory, path) = repository().await;
    let files: &[(&str, &[u8])] = &[
        (".gitattributes", b"*.data -diff\n*.text diff\n"),
        ("with spaces.txt", b"one\ntwo\n"),
        ("-leading", b"no trailing newline"),
        ("empty", b""),
        ("binary", b"one\0two\n"),
        ("forced.data", b"one\ntwo\n"),
        ("forced.text", b"one\0two\n"),
        #[cfg(unix)]
        ("with\nnewline.txt", b"one\ntwo\nthree"),
    ];
    for (name, bytes) in files {
        std::fs::write(path.join(name), bytes).unwrap();
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink("with spaces.txt", path.join("symlink")).unwrap();
    let bytes = run_git(
        &path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await;
    let (_, entries) = parse_status(&bytes).unwrap();
    let (batched, counts) = untracked_stats(&path, &entries).await.unwrap();
    let mut expected = DiffStats::default();
    for entry in &entries {
        let mut command = git(&path);
        command.args([
            "diff",
            "--no-index",
            "--numstat",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            null_device(),
            &entry.path,
        ]);
        let (stats, _) =
            parse_numstat_map(&ensure_diff(output(command).await.unwrap()).unwrap()).unwrap();
        expected.add(stats);
        assert_eq!(
            counts.get(&entry.path).copied().unwrap_or((0, 0)),
            (stats.additions, stats.deletions),
            "{}",
            entry.path
        );
    }
    assert_eq!(batched.additions, expected.additions);
    assert_eq!(batched.deletions, expected.deletions);
    assert!(!path.join(".git/index").exists());
    let object_directories = std::fs::read_dir(path.join(".git/objects"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        object_directories,
        [
            std::ffi::OsString::from("info"),
            std::ffi::OsString::from("pack")
        ]
        .into_iter()
        .collect()
    );
}

#[tokio::test]
async fn subdirectory_status_keeps_staged_worktree_and_untracked_paths_consistent() {
    let (_directory, path) = repository().await;
    std::fs::write(path.join("tracked.txt"), "one\ntwo\n").unwrap();
    run_git(&path, &["add", "tracked.txt"]).await;
    run_git(
        &path,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--quiet",
            "-m",
            "initial",
        ],
    )
    .await;
    std::fs::write(path.join("tracked.txt"), "one\nstaged\n").unwrap();
    run_git(&path, &["add", "tracked.txt"]).await;
    std::fs::write(path.join("tracked.txt"), "one\nworktree\nextra\n").unwrap();
    let subdirectory = path.join("sub");
    std::fs::create_dir(&subdirectory).unwrap();
    std::fs::write(subdirectory.join("-new.txt"), "one\ntwo\n").unwrap();
    std::fs::write(path.join("other.txt"), "one\n").unwrap();
    let index_before = std::fs::read(path.join(".git/index")).unwrap();
    let (state, session_id) = state_for(&subdirectory);
    let result = status(&state, Some(json!({"sessionId":session_id})))
        .await
        .unwrap();
    assert_eq!(
        std::fs::canonicalize(result["root"].as_str().unwrap()).unwrap(),
        path
    );
    assert_eq!(result["entries"].as_array().unwrap().len(), 3);
    assert_eq!(result["stats"]["additions"], 5);
    assert_eq!(result["stats"]["deletions"], 1);
    let changed = diff(
        &state,
        Some(json!({"sessionId":session_id, "path":"sub/-new.txt"})),
    )
    .await
    .unwrap();
    assert!(changed["diff"].as_str().unwrap().contains("+two"));
    assert_eq!(
        std::fs::read(path.join(".git/index")).unwrap(),
        index_before
    );
}

#[tokio::test]
async fn unborn_head_counts_staged_worktree_and_untracked_without_changing_index() {
    let (_directory, path) = repository().await;
    std::fs::write(path.join("staged.txt"), "one\ntwo\n").unwrap();
    run_git(&path, &["add", "staged.txt"]).await;
    std::fs::write(path.join("staged.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(path.join("untracked.txt"), "four\nfive\n").unwrap();
    let before = std::fs::read(path.join(".git/index")).unwrap();
    let (state, session_id) = state_for(&path);
    let result = status(&state, Some(json!({"sessionId":session_id})))
        .await
        .unwrap();
    assert_eq!(result["stats"]["additions"], 5);
    assert_eq!(result["stats"]["deletions"], 0);
    assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), before);
}

#[tokio::test]
async fn large_concurrent_status_requests_preserve_all_files_and_health_responsiveness() {
    let (_directory, path) = repository().await;
    for index in 0..1500 {
        std::fs::write(path.join(format!("file-{index}.txt")), "one\ntwo\n").unwrap();
    }
    let (state, session_id) = state_for(&path);
    let listener = crate::server::bind(0).await.unwrap();
    let address = listener.local_addr().unwrap();
    let serving_state = state.clone();
    let server = tokio::spawn(async move { crate::server::serve(listener, serving_state).await });
    let mut requests = Vec::new();
    for _ in 0..8 {
        let state = state.clone();
        let session_id = session_id.clone();
        requests.push(tokio::spawn(async move {
            let value = status(&state, Some(json!({"sessionId":session_id})))
                .await
                .unwrap();
            assert_eq!(value["entries"].as_array().unwrap().len(), 1500);
            assert_eq!(value["stats"]["additions"], 3000);
        }));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();
    for _ in 0..20 {
        let health = client
            .get(format!("http://{address}/health"))
            .send()
            .await
            .unwrap();
        assert!(health.status().is_success());
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    for request in requests {
        request.await.unwrap();
    }
    assert!(!path.join(".git/index").exists());
    state.shutdown.cancel();
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn sparse_checkout_counts_untracked_files_outside_the_selected_directories() {
    let (_directory, path) = repository().await;
    for name in ["inside", "outside"] {
        std::fs::create_dir(path.join(name)).unwrap();
        std::fs::write(path.join(name).join("tracked.txt"), "tracked\n").unwrap();
    }
    run_git(&path, &["add", "."]).await;
    run_git(
        &path,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--quiet",
            "-m",
            "initial",
        ],
    )
    .await;
    run_git(&path, &["sparse-checkout", "init", "--cone"]).await;
    run_git(&path, &["sparse-checkout", "set", "inside"]).await;
    std::fs::create_dir(path.join("outside")).unwrap();
    std::fs::write(path.join("outside/new.txt"), "one\ntwo\n").unwrap();
    let before = std::fs::read(path.join(".git/index")).unwrap();
    let (state, session_id) = state_for(&path);
    let result = status(&state, Some(json!({"sessionId":session_id})))
        .await
        .unwrap();
    assert_eq!(result["entries"].as_array().unwrap().len(), 1);
    assert_eq!(result["entries"][0]["path"], "outside/new.txt");
    assert_eq!(result["stats"]["additions"], 2);
    assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), before);
}
