import type { MiniqAppController } from "../hooks/useMiniqApp";
import { openExternalUrl } from "../externalLinks";
import { dispatchCommand, shortcutLabel, type CommandId } from "../shortcuts";
import { runEditingAction, type EditingAction } from "../menuEditing";

export interface AppMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void | Promise<unknown>;
}

export function appMenuItems(app: MiniqAppController | null, restoreEditor: () => void, showAbout: () => void): AppMenuItem[][][] {
  const command = (label: string, id: CommandId, disabled = false): AppMenuItem => ({
    label, shortcut: shortcutLabel(id), disabled: !app || disabled, run: () => dispatchCommand(id),
  });
  const edit = (label: string, action: EditingAction, key: string): AppMenuItem => ({
    label, shortcut: key, run: () => runEditingAction(action, restoreEditor),
  });
  const hasSession = !!app?.catalog.currentSession;
  return [
    [
      [command("新对话", "newChat"), { label: "打开项目文件夹…", disabled: !app || app.client.mode === "remote", run: () => app?.actions.openWorkspace() },
        { label: "导入会话…", disabled: !app, run: () => app?.navigation.setShowExternalImport(true) }],
      [command("设置…", "settings")],
    ],
    [
      [edit("撤销", "undo", "Ctrl+Z"), edit("重做", "redo", "Ctrl+Shift+Z")],
      [edit("剪切", "cut", "Ctrl+X"), edit("复制", "copy", "Ctrl+C"), edit("粘贴", "paste", "Ctrl+V"), edit("全选", "selectAll", "Ctrl+A")],
      [command("搜索当前会话", "find", !hasSession), command("重命名当前会话", "renameSession", !hasSession), command("复制会话为 Markdown", "copyMarkdown", !hasSession)],
    ],
    [
      [command(app?.navigation.sidebarCollapsed ? "显示侧栏" : "隐藏侧栏", "toggleSidebar"), command("搜索与命令面板", "palette")],
      [{ label: "已安排", disabled: !app, run: () => app?.navigation.setPage("schedule") },
        { label: "技能与连接器", disabled: !app, run: () => app?.navigation.setPage("skills") }],
      [command("上一个会话", "prevSession", !hasSession), command("下一个会话", "nextSession", !hasSession)],
    ],
    [
      [command("键盘快捷键", "showShortcuts"), { label: "帮助与支持", run: () => openExternalUrl("https://chat.zaiwenai.com/miniq/support") }],
      [{ label: "检查更新…", disabled: !app?.updater.supported, run: () => app?.updater.checkNow() }, { label: "关于 miniQ", run: showAbout }],
    ],
  ];
}
