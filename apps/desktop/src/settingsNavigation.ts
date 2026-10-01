/** Settings groups, in System Settings order. Shared by the sheet and navigation state. */
export const SETTINGS_TAB_IDS = [
  "general",
  "appearance",
  "services",
  "computer",
  "skills",
  "mcp",
  "plugins",
  "memory",
] as const;

export type SettingsTab = (typeof SETTINGS_TAB_IDS)[number];

export const DEFAULT_SETTINGS_TAB: SettingsTab = "services";

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && (SETTINGS_TAB_IDS as readonly string[]).includes(value);
}
