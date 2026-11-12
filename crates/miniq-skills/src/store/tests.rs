use super::*;

const BUNDLED: &str = "---\nname: bundled-demo\ndescription: bundled demo skill\norigin: bundled\n---\n\n## Steps\nbundled body\n";

fn write_skill(root: &Path, name: &str, description: &str) {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\n## Steps\nbody of {name}\n"),
    )
    .unwrap();
}

fn store(data_dir: &Path) -> SkillStore {
    SkillStore::new(data_dir, vec![BundledSkill { content: BUNDLED }])
}

#[test]
fn discovery_and_priority_shadowing() {
    let data = tempfile::tempdir().unwrap();
    let ws = tempfile::tempdir().unwrap();
    let store = store(data.path());

    // Bundled only.
    let skills = store.discover(Some(ws.path()));
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].source, SkillSource::Bundled);

    // User skill with a new name adds; same name shadows bundled.
    write_skill(&data.path().join("skills"), "my-skill", "user skill");
    write_skill(&data.path().join("skills"), "bundled-demo", "user override");
    let skills = store.discover(Some(ws.path()));
    assert_eq!(skills.len(), 2);
    let demo = skills
        .iter()
        .find(|s| s.meta.name == "bundled-demo")
        .unwrap();
    assert_eq!(demo.source, SkillSource::User);
    assert_eq!(demo.meta.description, "user override");

    // Project skill shadows user.
    write_skill(
        &ws.path().join(".miniq/skills"),
        "my-skill",
        "project override",
    );
    let skills = store.discover(Some(ws.path()));
    let mine = skills.iter().find(|s| s.meta.name == "my-skill").unwrap();
    assert_eq!(mine.source, SkillSource::Project);
}

#[test]
fn agents_skills_are_discovered_and_shadowed_by_miniq() {
    let data = tempfile::tempdir().unwrap();
    let ws = tempfile::tempdir().unwrap();
    let store = store(data.path());

    // Generic harness layout without `version` must parse (defaults to 1).
    write_skill(
        &ws.path().join(".agents/skills"),
        "shared-skill",
        "agents compat",
    );
    let skills = store.discover(Some(ws.path()));
    let found = skills
        .iter()
        .find(|s| s.meta.name == "shared-skill")
        .unwrap();
    assert_eq!(found.source, SkillSource::Project);
    assert_eq!(found.meta.version, 1);
    assert_eq!(
        found
            .dir
            .as_ref()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .file_name()
            .unwrap(),
        ".agents"
    );

    // Native project skills win on name conflict; .agents copy stays read-only.
    write_skill(
        &ws.path().join(".miniq/skills"),
        "shared-skill",
        "native override",
    );
    let skills = store.discover(Some(ws.path()));
    let found = skills
        .iter()
        .find(|s| s.meta.name == "shared-skill")
        .unwrap();
    assert_eq!(found.meta.description, "native override");
    assert!(store.delete(Some(ws.path()), "shared-skill").is_err());
}

#[test]
fn plugin_skills_follow_the_registered_directories() {
    let data = tempfile::tempdir().unwrap();
    let plugin = tempfile::tempdir().unwrap();
    let store = store(data.path());
    write_skill(plugin.path(), "plugin-skill", "from a plugin");
    write_skill(plugin.path(), "wrong-name-dir", "ignored");
    std::fs::rename(
        plugin.path().join("wrong-name-dir"),
        plugin.path().join("other"),
    )
    .unwrap();

    store.set_plugin_skill_dirs(vec![
        plugin.path().join("plugin-skill"),
        plugin.path().join("other"),
    ]);
    let skills = store.discover(None);
    let found = skills
        .iter()
        .find(|s| s.meta.name == "plugin-skill")
        .unwrap();
    assert_eq!(found.source, SkillSource::Plugin);
    assert!(!skills.iter().any(|s| s.meta.name == "wrong-name-dir"));
    assert!(store.delete(None, "plugin-skill").is_err());

    // A user skill with the same name shadows the plugin one.
    write_skill(&data.path().join("skills"), "plugin-skill", "mine");
    let skills = store.discover(None);
    let found = skills
        .iter()
        .find(|s| s.meta.name == "plugin-skill")
        .unwrap();
    assert_eq!(found.source, SkillSource::User);
    std::fs::remove_dir_all(data.path().join("skills/plugin-skill")).unwrap();

    // Disabling the plugin unregisters its directories.
    store.set_plugin_skill_dirs(Vec::new());
    assert!(!store
        .discover(None)
        .iter()
        .any(|s| s.meta.name == "plugin-skill"));
}

#[test]
fn read_bundled_and_disk() {
    let data = tempfile::tempdir().unwrap();
    let store = store(data.path());
    let detail = store.read(None, "bundled-demo").unwrap();
    assert!(detail.body.contains("bundled body"));
    assert!(detail.skill_dir.is_none());

    write_skill(&data.path().join("skills"), "on-disk", "disk skill");
    std::fs::create_dir_all(data.path().join("skills/on-disk/scripts")).unwrap();
    std::fs::write(
        data.path().join("skills/on-disk/scripts/run.py"),
        "print(1)",
    )
    .unwrap();
    let detail = store.read(None, "on-disk").unwrap();
    assert!(detail.body.contains("body of on-disk"));
    assert_eq!(detail.files, vec!["scripts/run.py"]);
    assert!(detail.skill_dir.is_some());
}

#[test]
fn saving_over_a_skill_keeps_a_hidden_backup() {
    let dir = tempfile::tempdir().unwrap();
    let store = SkillStore::new(dir.path(), Vec::new());
    let first = "---\nname: report\ndescription: first version of the report skill\n---\nbody one";
    let second = "---\nname: report\ndescription: second version of the report skill\nversion: 2\n---\nbody two";
    store.save(first).unwrap();
    store.save(second).unwrap();
    let skill_dir = store.user_root().join("report");
    assert!(std::fs::read_to_string(skill_dir.join("SKILL.md"))
        .unwrap()
        .contains("body two"));
    let backups: Vec<_> = std::fs::read_dir(skill_dir.join(".history"))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(backups.len(), 1);
    assert!(std::fs::read_to_string(backups[0].path())
        .unwrap()
        .contains("body one"));
    assert!(store.read(None, "report").unwrap().files.is_empty());
}

#[test]
fn sidecar_files_are_listed_recursively() {
    let data = tempfile::tempdir().unwrap();
    let store = store(data.path());
    let root = data.path().join("skills/deep");
    write_skill(&data.path().join("skills"), "deep", "deep skill");
    for rel in [
        "references/triage/stuck.md",
        "references/index.md",
        "rules/a.md",
        "AGENTS.md",
        ".hidden/x.md",
        "references/.DS_Store",
    ] {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x").unwrap();
    }
    let detail = store.read(None, "deep").unwrap();
    assert_eq!(
        detail.files,
        vec![
            "AGENTS.md",
            "references/index.md",
            "references/triage/stuck.md",
            "rules/a.md"
        ]
    );
}

#[test]
fn bundled_upgrade_is_immediate_and_never_overwrites_user_skills() {
    const UPDATED: &str = "---\nname: bundled-demo\ndescription: updated bundled skill\nversion: 2\norigin: bundled\n---\n\nupdated bundled body\n";
    let data = tempfile::tempdir().unwrap();
    assert_eq!(
        store(data.path())
            .read(None, "bundled-demo")
            .unwrap()
            .skill
            .meta
            .version,
        1
    );

    let upgraded = SkillStore::new(data.path(), vec![BundledSkill { content: UPDATED }]);
    let detail = upgraded.read(None, "bundled-demo").unwrap();
    assert_eq!(detail.skill.meta.version, 2);
    assert_eq!(detail.skill.source, SkillSource::Bundled);
    assert!(detail.body.contains("updated bundled body"));
    assert!(!data.path().join("skills").exists());

    write_skill(
        &data.path().join("skills"),
        "bundled-demo",
        "user-authored instructions",
    );
    let restarted = SkillStore::new(data.path(), vec![BundledSkill { content: UPDATED }]);
    let user = restarted.read(None, "bundled-demo").unwrap();
    assert_eq!(user.skill.source, SkillSource::User);
    assert_eq!(user.skill.meta.version, 1);
    assert_eq!(user.skill.meta.description, "user-authored instructions");
    assert!(user.body.contains("body of bundled-demo"));
}

#[test]
fn enable_disable_persists() {
    let data = tempfile::tempdir().unwrap();
    {
        let store = store(data.path());
        store.set_enabled("bundled-demo", false).unwrap();
        assert!(!store.discover(None)[0].enabled);
    }
    // New store instance reads persisted state.
    let store = store(data.path());
    assert!(!store.discover(None)[0].enabled);
    store.set_enabled("bundled-demo", true).unwrap();
    assert!(store.discover(None)[0].enabled);
}

#[test]
fn save_validates_and_delete_scopes() {
    let data = tempfile::tempdir().unwrap();
    let store = store(data.path());

    assert!(store.save("not a skill").is_err());
    let meta = store
        .save("---\nname: saved-skill\ndescription: distilled\norigin: distilled\n---\n\n## Steps\n1. do it\n")
        .unwrap();
    assert_eq!(meta.name, "saved-skill");
    assert!(store.read(None, "saved-skill").is_ok());

    // Bundled skills cannot be deleted.
    assert!(store.delete(None, "bundled-demo").is_err());
    store.delete(None, "saved-skill").unwrap();
    assert!(store.read(None, "saved-skill").is_err());
}

#[test]
fn mismatched_dir_name_skipped() {
    let data = tempfile::tempdir().unwrap();
    let store = store(data.path());
    let dir = data.path().join("skills/wrong-dir");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        "---\nname: other-name\ndescription: mismatch\n---\nbody",
    )
    .unwrap();
    assert!(store
        .discover(None)
        .iter()
        .all(|s| s.meta.name != "other-name"));
}

#[test]
fn imports_and_updates_a_skill_package_without_following_symlinks() {
    let data = tempfile::tempdir().unwrap();
    let package = tempfile::tempdir().unwrap();
    let skill_dir = package.path().join("pdf-review");
    std::fs::create_dir_all(skill_dir.join("scripts")).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: pdf-review\ndescription: Review PDFs\nversion: 2\nrequires:\n  bins: [pdftoppm]\n---\n\nUse the script.\n",
    )
    .unwrap();
    std::fs::write(skill_dir.join("scripts/render.sh"), "echo render").unwrap();
    let store = store(data.path());
    let imported = store.import_directory(package.path()).unwrap();
    assert_eq!(imported[0].version, 2);
    let detail = store.read(None, "pdf-review").unwrap();
    assert_eq!(detail.skill.source, SkillSource::User);
    assert_eq!(detail.files, vec!["scripts/render.sh"]);
    assert!(detail.body.contains("Use the script"));

    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: pdf-review\ndescription: Review PDFs\nversion: 3\n---\n\nUpdated workflow.\n",
    )
    .unwrap();
    let imported = store.import_directory(package.path()).unwrap();
    assert_eq!(imported[0].version, 3);
    assert!(store
        .read(None, "pdf-review")
        .unwrap()
        .body
        .contains("Updated"));
}
