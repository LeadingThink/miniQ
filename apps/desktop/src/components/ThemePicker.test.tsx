// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAppearance, initializeAppearance, storeTheme, subscribeAppearance } from "../theme";
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
  it("shows the appearance mode and three themes per side", () => {
    render(<Fixture />);
    expect(group("明暗外观").map((radio) => radio.value)).toEqual(["system", "light", "dark"]);
    expect(group("浅色主题").map((radio) => radio.value)).toEqual(["jade", "snow", "amber"]);
    expect(group("深色主题").map((radio) => radio.value)).toEqual(["night", "slate", "graphite"]);
    expect((screen.getByRole("radio", { name: "自动" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "浅玉" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "夜墨" }) as HTMLInputElement).checked).toBe(true);
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
