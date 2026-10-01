//! Native Chinese application menu (macOS only).
//!
//! Custom items do not act in Rust: they emit `menu-command` with a command id
//! string and the webview re-dispatches it as `miniq:command` on `window`, so
//! the menu, command palette and keyboard shortcuts share one command bus.
//! Edit items are predefined so the responder chain keeps ⌘C/⌘V/⌘Z working in
//! text inputs.

/// Tauri event carrying a command id (string payload) to the webview.
pub const MENU_COMMAND_EVENT: &str = "menu-command";
/// Menu item that really quits (closing the window only hides it to the tray).
/// Deliberately distinct from the tray's `quit`/`show` ids: tray listeners see
/// every menu event.
pub const QUIT_ID: &str = "app-menu.quit";
/// Opens the product website with the system browser.
pub const HELP_ID: &str = "app-menu.help";
pub const HELP_URL: &str = "https://chat.zaiwenai.com";

/// Every command id the frontend understands. Menu item ids are these strings.
pub const COMMAND_IDS: [&str; 16] = [
    "newChat",
    "settings",
    "toggleSidebar",
    "palette",
    "find",
    "showShortcuts",
    "prevSession",
    "nextSession",
    "nextAttention",
    "archiveSession",
    "togglePin",
    "markUnread",
    "markAllRead",
    "back",
    "forward",
    "copyMarkdown",
];

/// What a clicked app-menu item should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuAction {
    /// Forward to the webview command bus.
    Command(&'static str),
    Quit,
    OpenHelp,
}

/// Maps a menu item id to its action; unknown ids (tray items, predefined
/// items) are ignored.
pub fn menu_action(id: &str) -> Option<MenuAction> {
    match id {
        QUIT_ID => Some(MenuAction::Quit),
        HELP_ID => Some(MenuAction::OpenHelp),
        _ => COMMAND_IDS
            .iter()
            .find(|command| **command == id)
            .map(|command| MenuAction::Command(command)),
    }
}

/// Label and accelerator of each custom command item, in menu order per group.
/// `None` means the item has no key equivalent.
pub fn command_spec(id: &str) -> Option<(&'static str, Option<&'static str>)> {
    Some(match id {
        "newChat" => ("新建会话", Some("CmdOrCtrl+N")),
        "settings" => ("设置…", Some("CmdOrCtrl+,")),
        "toggleSidebar" => ("切换侧边栏", Some("CmdOrCtrl+B")),
        "palette" => ("命令面板", Some("CmdOrCtrl+K")),
        // No accelerator: ⌘F stays with the webview so Monaco and the session search both keep it.
        "find" => ("查找", None),
        "showShortcuts" => ("显示键盘快捷键", Some("CmdOrCtrl+/")),
        "back" => ("返回", Some("CmdOrCtrl+[")),
        "forward" => ("前进", Some("CmdOrCtrl+]")),
        "prevSession" => ("上一个会话", Some("CmdOrCtrl+Shift+[")),
        "nextSession" => ("下一个会话", Some("CmdOrCtrl+Shift+]")),
        "nextAttention" => ("下一个需关注的会话", Some("CmdOrCtrl+Alt+A")),
        "archiveSession" => ("归档", Some("CmdOrCtrl+Shift+A")),
        "togglePin" => ("置顶/取消置顶", Some("CmdOrCtrl+Alt+P")),
        "markUnread" => ("标为未读", Some("CmdOrCtrl+Shift+U")),
        "markAllRead" => ("全部标为已读", None),
        "copyMarkdown" => ("复制为 Markdown", None),
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
pub fn setup_app_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{
        AboutMetadataBuilder, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem,
        SubmenuBuilder,
    };
    use tauri::Emitter;

    let command = |id: &'static str| -> tauri::Result<MenuItem<tauri::Wry>> {
        let (label, accelerator) = command_spec(id).expect("known menu command");
        let mut builder = MenuItemBuilder::with_id(id, label);
        if let Some(accelerator) = accelerator {
            builder = builder.accelerator(accelerator);
        }
        builder.build(app)
    };

    let info = app.package_info();
    let about = AboutMetadataBuilder::new()
        .name(Some("miniQ"))
        .version(Some(info.version.to_string()))
        .copyright(Some("© 在问AI"))
        .build();
    let quit = MenuItemBuilder::with_id(QUIT_ID, "退出 miniQ")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "miniQ")
        .item(&PredefinedMenuItem::about(app, Some("关于 miniQ"), Some(about))?)
        .item(&command("settings")?)
        .separator()
        .item(&PredefinedMenuItem::services(app, Some("服务"))?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("隐藏 miniQ"))?)
        .item(&PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("全部显示"))?)
        .separator()
        .item(&quit)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "文件")
        .item(&command("newChat")?)
        .item(&PredefinedMenuItem::close_window(app, Some("关闭窗口"))?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&PredefinedMenuItem::undo(app, Some("撤销"))?)
        .item(&PredefinedMenuItem::redo(app, Some("重做"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("剪切"))?)
        .item(&PredefinedMenuItem::copy(app, Some("复制"))?)
        .item(&PredefinedMenuItem::paste(app, Some("粘贴"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("全选"))?)
        .separator()
        .item(&command("find")?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "视图")
        .item(&command("toggleSidebar")?)
        .item(&command("palette")?)
        .item(&command("showShortcuts")?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, Some("进入全屏"))?)
        .build()?;

    let go_menu = SubmenuBuilder::new(app, "前往")
        .item(&command("back")?)
        .item(&command("forward")?)
        .separator()
        .item(&command("prevSession")?)
        .item(&command("nextSession")?)
        .item(&command("nextAttention")?)
        .build()?;

    let session_menu = SubmenuBuilder::new(app, "会话")
        .item(&command("archiveSession")?)
        .item(&command("togglePin")?)
        .item(&command("markUnread")?)
        .item(&command("markAllRead")?)
        .separator()
        .item(&command("copyMarkdown")?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "窗口")
        .item(&PredefinedMenuItem::minimize(app, Some("最小化"))?)
        .item(&PredefinedMenuItem::maximize(app, Some("缩放"))?)
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(app, Some("全部置于顶层"))?)
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "帮助")
        .item(&MenuItemBuilder::with_id(HELP_ID, "miniQ 官网").build(app)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &go_menu,
            &session_menu,
            &window_menu,
            &help_menu,
        ])
        .build()?;
    app.set_menu(menu)?;
    // Lets AppKit add its window list and the help search field.
    let _ = window_menu.set_as_windows_menu_for_nsapp();
    let _ = help_menu.set_as_help_menu_for_nsapp();

    app.on_menu_event(|app, event| match menu_action(event.id().as_ref()) {
        Some(MenuAction::Command(id)) => {
            // Menu shortcuts also fire while the window is hidden to the tray.
            crate::show_main_window(app);
            if let Err(error) = app.emit(MENU_COMMAND_EVENT, id) {
                eprintln!("[miniq] could not forward menu command {id}: {error}");
            }
        }
        Some(MenuAction::Quit) => crate::request_quit(app),
        Some(MenuAction::OpenHelp) => {
            use tauri_plugin_opener::OpenerExt;
            if let Err(error) = app.opener().open_url(HELP_URL, None::<&str>) {
                eprintln!("[miniq] could not open help: {error}");
            }
        }
        None => {}
    });
    Ok(())
}

/// Windows and Linux keep their current window chrome without a menu bar.
#[cfg(not(target_os = "macos"))]
pub fn setup_app_menu(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_id_maps_to_itself() {
        for id in COMMAND_IDS {
            assert_eq!(menu_action(id), Some(MenuAction::Command(id)));
            assert!(command_spec(id).is_some(), "missing label for {id}");
        }
    }

    #[test]
    fn app_actions_do_not_collide_with_tray_ids() {
        assert_eq!(menu_action(QUIT_ID), Some(MenuAction::Quit));
        assert_eq!(menu_action(HELP_ID), Some(MenuAction::OpenHelp));
        assert_eq!(menu_action("quit"), None);
        assert_eq!(menu_action("show"), None);
        assert_eq!(menu_action(""), None);
        assert_eq!(menu_action("NewChat"), None);
    }

    #[test]
    fn accelerators_are_unique_and_leave_editing_keys_alone() {
        let mut seen = std::collections::HashSet::new();
        for id in COMMAND_IDS {
            if let Some(accelerator) = command_spec(id).and_then(|(_, a)| a) {
                assert!(accelerator.starts_with("CmdOrCtrl+"), "{accelerator}");
                assert!(seen.insert(accelerator), "duplicate accelerator {accelerator}");
                // Predefined edit items own these; stealing them breaks inputs.
                for reserved in ["CmdOrCtrl+C", "CmdOrCtrl+V", "CmdOrCtrl+X", "CmdOrCtrl+Z", "CmdOrCtrl+A", "CmdOrCtrl+Q", "CmdOrCtrl+W"] {
                    assert_ne!(accelerator, reserved);
                }
            }
        }
    }

    #[test]
    fn command_ids_are_unique() {
        let unique: std::collections::HashSet<_> = COMMAND_IDS.iter().collect();
        assert_eq!(unique.len(), COMMAND_IDS.len());
    }
}
