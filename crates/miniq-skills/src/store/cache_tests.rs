use super::*;

fn write_skill(root: &Path, name: &str, description: &str, body: &str) {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\n{body}"),
    )
    .unwrap();
}

fn counts(store: &SkillStore) -> (usize, usize) {
    let cache = store.cache.lock().unwrap();
    (cache.file_loads, cache.root_scans)
}

#[test]
fn discovery_and_reads_reuse_parsed_files_and_root_indexes() {
    let data = tempfile::tempdir().unwrap();
    let root = data.path().join("skills");
    let body = "complete instructions\n".repeat(10_000);
    write_skill(&root, "alpha", "First skill", &body);
    write_skill(&root, "beta", "Second skill", "second body");
    let store = SkillStore::new(data.path(), Vec::new());
    assert_eq!(store.discover(None).len(), 2);
    assert_eq!(counts(&store), (2, 1));
    for _ in 0..4 {
        assert_eq!(store.discover(None).len(), 2);
        assert_eq!(store.read(None, "alpha").unwrap().body, body);
    }
    assert_eq!(counts(&store), (2, 1));
}

#[test]
fn exact_read_does_not_scan_or_load_unrelated_skills() {
    let data = tempfile::tempdir().unwrap();
    let root = data.path().join("skills");
    write_skill(&root, "alpha", "First skill", "first body");
    write_skill(&root, "beta", "Second skill", "second body");
    let store = SkillStore::new(data.path(), Vec::new());
    assert_eq!(store.read(None, "beta").unwrap().body, "second body");
    assert_eq!(counts(&store), (1, 0));
    assert!(store.read(None, "../alpha").is_err());
    assert!(store.read(None, "/alpha").is_err());
    assert_eq!(counts(&store), (1, 0));
}

#[test]
fn workspace_indexes_preserve_shadowing_and_do_not_leak_between_projects() {
    let data = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let store = SkillStore::new(data.path(), Vec::new());
    write_skill(&data.path().join("skills"), "shared", "user", "user body");
    write_skill(
        &first.path().join(".agents/skills"),
        "shared",
        "generic",
        "generic body",
    );
    write_skill(
        &first.path().join(".miniq/skills"),
        "shared",
        "native",
        "native body",
    );
    write_skill(
        &second.path().join(".miniq/skills"),
        "shared",
        "second",
        "second body",
    );
    assert_eq!(
        store.discover(Some(first.path()))[0].meta.description,
        "native"
    );
    assert_eq!(
        store.read(Some(second.path()), "shared").unwrap().body,
        "second body"
    );
    assert_eq!(
        store.read(Some(first.path()), "shared").unwrap().body,
        "native body"
    );
    std::fs::remove_dir_all(first.path().join(".miniq/skills/shared")).unwrap();
    assert_eq!(
        store.read(Some(first.path()), "shared").unwrap().body,
        "generic body"
    );
    std::fs::remove_dir_all(first.path().join(".agents/skills/shared")).unwrap();
    assert_eq!(
        store.read(Some(first.path()), "shared").unwrap().body,
        "user body"
    );
    assert_eq!(
        store.discover(Some(second.path()))[0].meta.description,
        "second"
    );
}

#[test]
fn external_additions_edits_deletions_and_invalid_files_refresh() {
    let data = tempfile::tempdir().unwrap();
    let root = data.path().join("skills");
    std::fs::create_dir_all(root.join("later")).unwrap();
    write_skill(&root, "alpha", "initial", "initial body");
    let store = SkillStore::new(data.path(), Vec::new());
    assert_eq!(store.discover(None).len(), 1);
    // Creating SKILL.md inside an existing directory does not change the root mtime.
    write_skill(&root, "later", "appeared", "new body");
    assert_eq!(store.discover(None).len(), 2);
    write_skill(&root, "alpha", "changed description", "edited full body");
    assert_eq!(store.read(None, "alpha").unwrap().body, "edited full body");
    write_skill(&root, "third", "new directory", "third body");
    assert_eq!(store.discover(None).len(), 3);
    std::fs::write(root.join("alpha/SKILL.md"), "invalid").unwrap();
    assert!(store.read(None, "alpha").is_err());
    let before = counts(&store).0;
    assert_eq!(store.discover(None).len(), 2);
    assert_eq!(counts(&store).0, before);
    write_skill(&root, "alpha", "valid again", "recovered body");
    assert_eq!(store.read(None, "alpha").unwrap().body, "recovered body");
    std::fs::remove_file(root.join("alpha/SKILL.md")).unwrap();
    std::fs::remove_dir_all(root.join("third")).unwrap();
    assert_eq!(store.discover(None).len(), 1);
    assert!(store.read(None, "alpha").is_err());
}

#[test]
fn explicit_updates_refresh_cached_skills_and_enabled_state_immediately() {
    let data = tempfile::tempdir().unwrap();
    let package = tempfile::tempdir().unwrap();
    let store = SkillStore::new(data.path(), Vec::new());
    let original = "---\nname: alpha\ndescription: old\n---\n\nold body";
    let updated = "---\nname: alpha\ndescription: new\n---\n\nnew body";
    store.save(original).unwrap();
    assert_eq!(store.discover(None)[0].meta.description, "old");
    let before = counts(&store);
    store.set_enabled("alpha", false).unwrap();
    assert!(!store.read(None, "alpha").unwrap().skill.enabled);
    store.set_enabled("alpha", true).unwrap();
    assert!(store.discover(None)[0].enabled);
    assert_eq!(counts(&store), before);
    store.save(updated).unwrap();
    assert_eq!(store.read(None, "alpha").unwrap().body, "new body");
    write_skill(package.path(), "alpha", "imported", "imported body");
    store.import_directory(package.path()).unwrap();
    assert_eq!(store.read(None, "alpha").unwrap().body, "imported body");
    assert_eq!(store.discover(None)[0].meta.description, "imported");
    store.delete(None, "alpha").unwrap();
    assert!(store.discover(None).is_empty());
    assert!(store.read(None, "alpha").is_err());
}

#[test]
fn plugin_changes_and_duplicate_names_follow_registration_order() {
    let data = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    write_skill(first.path(), "shared", "first plugin", "first body");
    write_skill(second.path(), "shared", "second plugin", "second body");
    let store = SkillStore::new(data.path(), Vec::new());
    store.set_plugin_skill_dirs(vec![
        first.path().join("shared"),
        second.path().join("shared"),
    ]);
    assert_eq!(store.discover(None)[0].meta.description, "second plugin");
    assert_eq!(store.read(None, "shared").unwrap().body, "second body");
    store.set_plugin_skill_dirs(vec![first.path().join("shared")]);
    assert_eq!(store.read(None, "shared").unwrap().body, "first body");
    store
        .save("---\nname: shared\ndescription: user\n---\n\nuser body")
        .unwrap();
    assert_eq!(store.read(None, "shared").unwrap().body, "user body");
    store.delete(None, "shared").unwrap();
    assert_eq!(store.read(None, "shared").unwrap().body, "first body");
    store.set_plugin_skill_dirs(Vec::new());
    assert!(store.read(None, "shared").is_err());
    assert!(store.discover(None).is_empty());
}

#[test]
fn concurrent_cache_misses_load_each_skill_once() {
    let data = tempfile::tempdir().unwrap();
    write_skill(&data.path().join("skills"), "alpha", "alpha", "alpha body");
    write_skill(&data.path().join("skills"), "beta", "beta", "beta body");
    let store = SkillStore::new(data.path(), Vec::new());
    let barrier = std::sync::Barrier::new(8);
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                barrier.wait();
                assert_eq!(store.discover(None).len(), 2);
                assert_eq!(store.read(None, "alpha").unwrap().body, "alpha body");
            });
        }
    });
    assert_eq!(counts(&store), (2, 1));
}

#[test]
fn bounded_revalidation_rereads_unchanged_metadata_without_sleeping() {
    let data = tempfile::tempdir().unwrap();
    write_skill(&data.path().join("skills"), "alpha", "alpha", "alpha body");
    let store = SkillStore::new(data.path(), Vec::new());
    store.discover(None);
    assert_eq!(counts(&store), (1, 1));
    store.cache.lock().unwrap().expire();
    assert_eq!(store.discover(None).len(), 1);
    assert_eq!(counts(&store), (2, 2));
}

#[test]
fn dependency_status_refreshes_without_reloading_skill_contents() {
    let data = tempfile::tempdir().unwrap();
    let binary = data.path().join("available-later");
    let command = serde_json::to_string(binary.to_str().unwrap()).unwrap();
    let store = SkillStore::new(data.path(), Vec::new());
    store.save(&format!("---\nname: alpha\ndescription: dependencies\nrequires:\n  bins: [{command}]\n---\n\nbody")).unwrap();
    assert!(!store.read(None, "alpha").unwrap().skill.dependencies[0].available);
    let before = counts(&store).0;
    std::fs::write(&binary, "binary").unwrap();
    assert!(store.read(None, "alpha").unwrap().skill.dependencies[0].available);
    std::fs::remove_file(binary).unwrap();
    assert!(!store.discover(None)[0].dependencies[0].available);
    assert_eq!(counts(&store).0, before);
}

#[cfg(unix)]
#[test]
fn replacing_a_cached_directory_with_a_symlink_hides_the_skill() {
    let data = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    write_skill(
        &data.path().join("skills"),
        "alpha",
        "alpha",
        "original body",
    );
    write_skill(other.path(), "alpha", "other", "symlink target body");
    let store = SkillStore::new(data.path(), Vec::new());
    assert_eq!(store.read(None, "alpha").unwrap().body, "original body");
    let directory = data.path().join("skills/alpha");
    std::fs::remove_dir_all(&directory).unwrap();
    std::os::unix::fs::symlink(other.path().join("alpha"), directory).unwrap();
    assert!(store.read(None, "alpha").is_err());
    assert!(store.discover(None).is_empty());
}
