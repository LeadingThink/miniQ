import {
  Archive,
  ArrowLeft,
  ArrowRight,
  BellRing,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Keyboard,
  Mail,
  PanelLeft,
  Pin,
  PinOff,
} from "lucide-react";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { shortcutLabel, type CommandId } from "../shortcuts";
import type { PaletteCommand } from "./Search";

type Run = (id: CommandId) => boolean | void;

/** Command palette entries; every action shares the runner used by shortcuts and the menu bus. */
export function buildPaletteCommands(app: MiniqAppController, run: Run, mac?: boolean): PaletteCommand[] {
  const key = (id: CommandId) => shortcutLabel(id, mac) || undefined;
  const command = (id: CommandId, label: string, icon: PaletteCommand["icon"], keywords?: string[]): PaletteCommand => ({
    id,
    label,
    icon,
    shortcut: key(id),
    keywords,
    run: () => void run(id),
  });
  const current = app.catalog.currentSession;
  const commands: PaletteCommand[] = [
    { ...command("newChat", "新建会话", "new", ["new chat"]), id: "new-chat" },
    { ...command("settings", "打开设置", "settings", ["settings"]), id: "settings" },
    { id: "skills", label: "技能", icon: "skills", keywords: ["工作流", "skills"], run: () => app.navigation.setPage("skills") },
    { id: "mcp", label: "连接器", icon: "mcp", keywords: ["MCP", "外部工具"], run: () => app.navigation.setPage("mcp") },
    { id: "schedule", label: "已安排的任务", icon: "schedule", run: () => app.navigation.setPage("schedule") },
    command("toggleSidebar", app.navigation.sidebarCollapsed ? "显示侧栏" : "隐藏侧栏", PanelLeft, ["sidebar"]),
    command("showShortcuts", "键盘快捷键", Keyboard, ["shortcuts", "keyboard", "快捷键"]),
    command("prevSession", "上一个会话", ChevronUp, ["previous session"]),
    command("nextSession", "下一个会话", ChevronDown, ["next session"]),
    command("nextAttention", "下一个需要处理的会话", BellRing, ["attention", "未读", "审批"]),
    command("back", "后退", ArrowLeft, ["back"]),
    command("forward", "前进", ArrowRight, ["forward"]),
    command("markAllRead", "全部标为已读", CheckCheck, ["mark all read"]),
  ];
  if (current) {
    commands.push(
      command("archiveSession", "归档当前会话", Archive, ["archive"]),
      command("togglePin", current.pinned ? "取消置顶当前会话" : "置顶当前会话", current.pinned ? PinOff : Pin, ["pin"]),
      command("markUnread", "将当前会话标为未读", Mail, ["unread"]),
      command("copyMarkdown", "复制当前会话为 Markdown", ClipboardCopy, ["copy", "markdown", "导出"]),
    );
  }
  return commands;
}
