import { describe, expect, it } from "vitest";
import { SETTINGS_GROUPS, settingsGroupsFromSchema } from "./SettingsTabs";

describe("settingsGroupsFromSchema", () => {
  it("falls back to the static groups without a usable schema", () => {
    expect(settingsGroupsFromSchema(null)).toBe(SETTINGS_GROUPS);
    expect(settingsGroupsFromSchema({})).toBe(SETTINGS_GROUPS);
    expect(settingsGroupsFromSchema({ groups: [{ id: "unknown" }] })).toBe(SETTINGS_GROUPS);
  });

  it("follows daemon order and labels, skips unknown ids and keeps omitted groups reachable", () => {
    const groups = settingsGroupsFromSchema({ groups: [
      { id: "services", label: "服务", icon: "server" },
      { id: "models", label: "模型", icon: "bot" },
      { id: "general", label: "", icon: "settings" },
    ] });
    expect(groups.map((group) => group.id)).toEqual([
      "services", "general", "appearance", "computer", "skills", "mcp", "plugins", "memory",
    ]);
    expect(groups[0].label).toBe("服务");
    expect(groups[1].label).toBe("通用");
  });
});
