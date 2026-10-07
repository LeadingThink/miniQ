// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAppearance, initializeAppearance, storeTheme, subscribeAppearance, THEMES } from "../theme";
import { ThemePicker } from "./ThemePicker";

function Fixture() {
  const { theme } = useSyncExternalStore(subscribeAppearance, getAppearance);
  return <ThemePicker theme={theme} onThemeChange={storeTheme} />;
}

beforeEach(() => {
  localStorage.clear();
  initializeAppearance();
});
afterEach(cleanup);
const group = (name: string) =>
  within(screen.getByRole("radiogroup", { name })).getAllByRole("radio") as HTMLInputElement[];

describe("theme picker", () => {
  it("shows the appearance mode and a bounded first page per side", () => {
    render(<Fixture />);
    expect(group("明暗外观").map((radio) => radio.value)).toEqual(["system", "light", "dark"]);
    expect(group("浅色主题").slice(0, 3).map((radio) => radio.value)).toEqual(["jade", "snow", "amber"]);
    expect(group("深色主题").slice(0, 3).map((radio) => radio.value)).toEqual(["night", "slate", "graphite"]);
    expect((screen.getByRole("radio", { name: "自动" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "浅玉" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "夜墨" }) as HTMLInputElement).checked).toBe(true);
  });

  it("makes every palette reachable through pagination without duplicates", () => {
    render(<Fixture />);
    for (const [mode, label] of [["light", "浅色主题"], ["dark", "深色主题"]] as const) {
      const seen: string[] = [];
      for (;;) {
        const radios = group(label);
        expect(radios.length).toBeLessThanOrEqual(12);
        seen.push(...radios.map((radio) => radio.value));
        const next = screen.getByRole("button", { name: `下一页${label}` }) as HTMLButtonElement;
        if (next.disabled) break;
        fireEvent.click(next);
      }
      expect(seen).toEqual(THEMES.filter((theme) => theme.mode === mode).map((theme) => theme.id));
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it("combines search with categories and resets pagination", () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "下一页浅色主题" }));
    fireEvent.change(screen.getByRole("combobox", { name: "配色主题分类" }), { target: { value: "nature" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索配色主题" }), { target: { value: "moss-path" } });
    expect(group("浅色主题").map((radio) => radio.value)).toEqual(["moss-path"]);
    fireEvent.click(group("浅色主题")[0]);
    expect(getAppearance().lastThemes.light).toBe("moss-path");
    fireEvent.change(screen.getByRole("combobox", { name: "配色主题分类" }), { target: { value: "classic" } });
    expect(screen.getAllByText("没有匹配的配色主题，请调整搜索或分类。")).toHaveLength(2);
  });

  it("switches modes and keeps each side's theme", () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole("radio", { name: "深空" }));
    expect(getAppearance()).toMatchObject({ theme: "jade", lastThemes: { dark: "slate" } });
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    expect(getAppearance()).toMatchObject({ mode: "dark", theme: "slate" });
    expect(document.documentElement.dataset.themeMode).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "琥珀" }));
    expect(getAppearance()).toMatchObject({ mode: "light", theme: "amber", lastThemes: { dark: "slate" } });
    expect((screen.getByRole("radio", { name: "浅色" }) as HTMLInputElement).checked).toBe(true);
  });
});
