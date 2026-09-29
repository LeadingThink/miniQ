/**
 * Single source of truth for miniQ keyboard shortcuts and app commands.
 *
 * The shortcut dialog, command palette keycaps and the global keyboard
 * handler all read from this registry so the displayed keys never drift from
 * the keys that are actually handled.
 */

/** Command ids accepted by the `miniq:command` window event bus. */
export const COMMAND_IDS = [
  "newChat",
  "settings",
  "toggleSidebar",
  "palette",
  "find",
  "showShortcuts",
  "prevSession",
  "nextSession",
  "prevRecentSession",
  "nextRecentSession",
  "nextAttention",
  "archiveSession",
  "togglePin",
  "markUnread",
  "markAllRead",
  "back",
  "forward",
  "copyMarkdown",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

export const COMMAND_EVENT = "miniq:command";

export interface CommandEventDetail {
  id: CommandId;
}

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === "string" && (COMMAND_IDS as readonly string[]).includes(value);
}

/** Dispatch a command through the window event bus. */
export function dispatchCommand(id: CommandId, target: EventTarget = window) {
  target.dispatchEvent(new CustomEvent<CommandEventDetail>(COMMAND_EVENT, { detail: { id } }));
}

export type ShortcutSection = "通用" | "导航" | "会话" | "输入框" | "面板";

export const SHORTCUT_SECTIONS: readonly ShortcutSection[] = ["通用", "导航", "会话", "输入框", "面板"];

export type ShortcutId =
  | CommandId
  | "stop"
  | "openSessionN"
  | "send"
  | "newline"
  | "closeOverlay";

export interface ShortcutDefinition {
  id: ShortcutId;
  title: string;
  section: ShortcutSection;
  /** Keycaps shown on macOS. */
  mac: readonly string[];
  /** Keycaps shown on Windows / Linux. */
  other: readonly string[];
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: "palette", title: "打开命令面板", section: "通用", mac: ["⌘", "K"], other: ["Ctrl", "K"] },
  { id: "newChat", title: "新对话", section: "通用", mac: ["⌘", "N"], other: ["Ctrl", "N"] },
  { id: "settings", title: "打开设置", section: "通用", mac: ["⌘", ","], other: ["Ctrl", ","] },
  { id: "toggleSidebar", title: "显示/隐藏侧栏", section: "通用", mac: ["⌘", "B"], other: ["Ctrl", "B"] },
  { id: "showShortcuts", title: "键盘快捷键", section: "通用", mac: ["⌘", "/"], other: ["Ctrl", "/"] },

  { id: "prevSession", title: "上一个会话", section: "导航", mac: ["⌘", "⇧", "["], other: ["Ctrl", "Shift", "["] },
  { id: "nextSession", title: "下一个会话", section: "导航", mac: ["⌘", "⇧", "]"], other: ["Ctrl", "Shift", "]"] },
  { id: "nextRecentSession", title: "切换到最近使用的会话", section: "导航", mac: ["⌃", "Tab"], other: ["Ctrl", "Tab"] },
  { id: "prevRecentSession", title: "反向切换最近使用的会话", section: "导航", mac: ["⌃", "⇧", "Tab"], other: ["Ctrl", "Shift", "Tab"] },
  { id: "openSessionN", title: "打开侧栏第 1–9 个会话", section: "导航", mac: ["⌘", "1–9"], other: ["Ctrl", "1–9"] },
  { id: "nextAttention", title: "下一个需要处理的会话", section: "导航", mac: ["⌘", "⌥", "A"], other: ["Ctrl", "Alt", "A"] },
  { id: "back", title: "后退", section: "导航", mac: ["⌘", "["], other: ["Ctrl", "["] },
  { id: "forward", title: "前进", section: "导航", mac: ["⌘", "]"], other: ["Ctrl", "]"] },

  { id: "archiveSession", title: "归档当前会话", section: "会话", mac: ["⌘", "⇧", "A"], other: ["Ctrl", "Shift", "A"] },
  { id: "togglePin", title: "置顶/取消置顶当前会话", section: "会话", mac: ["⌘", "⌥", "P"], other: ["Ctrl", "Alt", "P"] },
  { id: "markUnread", title: "将当前会话标为未读", section: "会话", mac: ["⌘", "⇧", "U"], other: ["Ctrl", "Shift", "U"] },
  { id: "markAllRead", title: "全部标为已读", section: "会话", mac: ["⇧", "Esc"], other: ["Shift", "Esc"] },
  { id: "stop", title: "停止当前回复", section: "会话", mac: ["⌘", "."], other: ["Ctrl", "."] },
  { id: "copyMarkdown", title: "复制当前会话为 Markdown", section: "会话", mac: [], other: [] },

  { id: "send", title: "发送消息", section: "输入框", mac: ["Enter"], other: ["Enter"] },
  { id: "newline", title: "换行", section: "输入框", mac: ["⇧", "Enter"], other: ["Shift", "Enter"] },

  { id: "find", title: "在当前会话中搜索", section: "面板", mac: ["⌘", "F"], other: ["Ctrl", "F"] },
  { id: "closeOverlay", title: "关闭弹窗或面板", section: "面板", mac: ["Esc"], other: ["Esc"] },
];

const BY_ID = new Map<ShortcutId, ShortcutDefinition>(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));

export function shortcutDefinition(id: ShortcutId): ShortcutDefinition | undefined {
  return BY_ID.get(id);
}

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(`${navigator.platform} ${navigator.userAgent}`);
}

/** Keycaps for a shortcut on the given platform (empty when unbound). */
export function shortcutKeys(id: ShortcutId, mac = isApplePlatform()): readonly string[] {
  const definition = BY_ID.get(id);
  if (!definition) return [];
  return mac ? definition.mac : definition.other;
}

/** Human readable label such as `⌘⇧A` or `Ctrl+Shift+A`. */
export function shortcutLabel(id: ShortcutId, mac = isApplePlatform()): string {
  const keys = shortcutKeys(id, mac);
  return mac ? keys.join("") : keys.join("+");
}

export function groupShortcuts(shortcuts: readonly ShortcutDefinition[] = SHORTCUTS) {
  return SHORTCUT_SECTIONS.map((section) => ({
    section,
    shortcuts: shortcuts.filter((shortcut) => shortcut.section === section),
  })).filter((group) => group.shortcuts.length > 0);
}

export type ShortcutMatch =
  | { id: Exclude<CommandId, "palette" | "newChat" | "settings" | "toggleSidebar" | "find"> }
  | { id: "openSessionN"; index: number };

function isEditable(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target"> & {
  isComposing?: boolean;
};

/**
 * Match the navigation/session shortcuts that were added on top of the
 * original ⌘K/⌘N/⌘,/⌘./⌘B/⌘F set. Physical `code` is used for letters,
 * digits and brackets because ⌥ and ⇧ change `key` (e.g. ⌘⇧[ → `{`).
 */
export function matchShortcut(event: KeyLike, mac = isApplePlatform()): ShortcutMatch | null {
  if (event.isComposing) return null;
  const editable = isEditable(event.target);

  // Ctrl+Tab / Ctrl+Shift+Tab (also Ctrl on macOS, like browsers).
  if (event.key === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey) {
    return { id: event.shiftKey ? "prevRecentSession" : "nextRecentSession" };
  }

  // ⇧Esc — mark everything read. Plain Esc stays with overlays / inputs.
  if (event.key === "Escape" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    return { id: "markAllRead" };
  }

  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary) return null;
  const { code, shiftKey: shift, altKey: alt } = event;

  if (!shift && !alt && (event.key === "/" || code === "Slash")) return { id: "showShortcuts" };

  if (!alt && code === "BracketLeft") return { id: shift ? "prevSession" : "back" };
  if (!alt && code === "BracketRight") return { id: shift ? "nextSession" : "forward" };

  if (!shift && !alt && /^Digit[1-9]$/.test(code)) {
    return { id: "openSessionN", index: Number(code.slice(5)) - 1 };
  }

  if (shift && !alt && code === "KeyA") return { id: "archiveSession" };
  if (shift && !alt && code === "KeyU") return { id: "markUnread" };

  if (alt && !shift) {
    // Ctrl+Alt is AltGr on many non-Mac layouts; let it type characters.
    if (!mac && editable) return null;
    if (code === "KeyA") return { id: "nextAttention" };
    if (code === "KeyP") return { id: "togglePin" };
  }
  return null;
}
