import {
  Brain,
  Monitor,
  Palette,
  Plug,
  PlugZap,
  Server,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { SettingsTab } from "../settingsNavigation";

export type { SettingsTab } from "../settingsNavigation";

export interface SettingsGroup {
  id: SettingsTab;
  label: string;
  icon: LucideIcon;
  /** One-line explanation rendered under the group title in the content pane. */
  description?: string;
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: "general", label: "通用", icon: SlidersHorizontal, description: "任务完成提醒与通知方式。" },
  { id: "appearance", label: "外观", icon: Palette, description: "主题与配色。" },
  { id: "services", label: "服务与远程", icon: Server, description: "模型服务、API Key、远程访问与 SSH 主机。" },
  { id: "computer", label: "电脑控制", icon: Monitor, description: "屏幕录制与辅助功能授权。" },
  { id: "skills", label: "技能", icon: Sparkles, description: "可复用的工作流程与说明。" },
  { id: "mcp", label: "MCP 连接", icon: PlugZap, description: "连接外部工具与数据源。" },
  { id: "plugins", label: "插件", icon: Plug, description: "安装和管理扩展能力。" },
  { id: "memory", label: "记忆", icon: Brain, description: "miniQ 记住的偏好与项目事实。" },
];

/** Shape returned by the daemon `settings.schema` RPC. */
export interface SettingsSchema {
  groups?: { id?: unknown; label?: unknown; icon?: unknown }[];
}

/**
 * Merge the daemon-provided group order/labels with the static list. Unknown
 * ids (e.g. groups this client cannot render yet) are skipped, and any static
 * group the daemon omitted is appended so every panel stays reachable.
 */
export function settingsGroupsFromSchema(schema: SettingsSchema | null | undefined): readonly SettingsGroup[] {
  if (!schema || !Array.isArray(schema.groups)) return SETTINGS_GROUPS;
  const merged: SettingsGroup[] = [];
  for (const entry of schema.groups) {
    const known = SETTINGS_GROUPS.find((group) => group.id === entry?.id);
    if (!known || merged.some((group) => group.id === known.id)) continue;
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : known.label;
    merged.push({ ...known, label });
  }
  if (merged.length === 0) return SETTINGS_GROUPS;
  for (const group of SETTINGS_GROUPS) if (!merged.some((item) => item.id === group.id)) merged.push(group);
  return merged;
}

export function settingsGroup(id: SettingsTab, groups: readonly SettingsGroup[] = SETTINGS_GROUPS): SettingsGroup {
  return groups.find((group) => group.id === id) ?? SETTINGS_GROUPS.find((group) => group.id === id) ?? SETTINGS_GROUPS[0];
}

const NEXT_KEYS = ["ArrowDown", "ArrowRight"];
const PREVIOUS_KEYS = ["ArrowUp", "ArrowLeft"];

/** macOS System Settings–style vertical group list. */
export function SettingsTabs({ selected, onSelect, groups = SETTINGS_GROUPS }: {
  selected: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
  groups?: readonly SettingsGroup[];
}) {
  return <nav className="settings-sidebar-nav">
    <div className="settings-tabs" role="tablist" aria-label="设置分类" aria-orientation="vertical">
      {groups.map(({ id, label, icon: Icon }, index) => <button
        key={id}
        type="button"
        role="tab"
        id={`settings-tab-${id}`}
        aria-controls={`settings-${id}`}
        aria-selected={selected === id}
        tabIndex={selected === id ? 0 : -1}
        onClick={() => onSelect(id)}
        onKeyDown={(event) => {
          const next = NEXT_KEYS.includes(event.key);
          const previous = PREVIOUS_KEYS.includes(event.key);
          if (!next && !previous && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? groups.length - 1
            : (index + (previous ? -1 : 1) + groups.length) % groups.length;
          const target = groups[nextIndex].id;
          onSelect(target);
          document.getElementById(`settings-tab-${target}`)?.focus();
        }}
      >
        <span className="settings-tab-icon" aria-hidden="true"><Icon size={14} /></span>
        {label}
      </button>)}
    </div>
  </nav>;
}
