// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAppearance,
  initializeAppearance,
  storeTheme,
  subscribeAppearance,
  THEMES,
  FAVORITES_STORAGE_KEY,
} from "../theme";
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
const choices = () =>
  within(screen.getByRole("radiogroup", { name: "外观主题" })).getAllByRole("radio") as HTMLInputElement[];
const filter = (label: string, value: string) =>
  fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value } });

describe("theme picker", () => {
  it("paginates the entire catalog without dropping themes", () => {
    render(<Fixture />);
    filter("主题集", "all");
    const ids: string[] = [];
    for (let page = 0; page < 9; page++) {
      const radios = choices();
      expect(radios).toHaveLength(12);
      ids.push(...radios.map((radio) => radio.value));
      if (page < 8) fireEvent.click(screen.getByRole("button", { name: "下一页主题" }));
    }
    expect(ids).toEqual(THEMES.map((theme) => theme.id));
    expect((screen.getByRole("button", { name: "下一页主题" }) as HTMLButtonElement).disabled).toBe(true);
    filter("主题分类", "nature");
    expect(choices()).toHaveLength(12);
    expect(choices()[0].value).toBe("moss-path");
    filter("主题明暗", "dark");
    expect(choices().map((radio) => radio.value)).toEqual(["aurora-lake", "volcanic-ash"]);
  });

  it("searches nonfeatured themes by name, description, category and ID", () => {
    render(<Fixture />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: " NAVY-OFFICE " } });
    expect(choices()).toHaveLength(1);
    fireEvent.click(screen.getByRole("radio", { name: "深海办公室" }));
    expect(getAppearance().theme).toBe("navy-office");
    expect(document.documentElement.dataset.themeMode).toBe("dark");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "没有这样的主题" } });
    expect(screen.getByText("没有匹配的主题")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
    expect(choices()).toHaveLength(12);
  });

  it("favorites without changing the selected palette and recovers from an empty collection", () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "收藏夜墨" }));
    expect(getAppearance().theme).toBe("jade");
    filter("主题集", "favorites");
    expect(choices().map((radio) => radio.value)).toEqual(["night"]);
    fireEvent.click(screen.getByRole("button", { name: "取消收藏夜墨" }));
    expect(screen.getByText("暂无收藏主题")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
    expect(choices()).toHaveLength(12);
  });

  it("clamps pagination when another window removes favorites", () => {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(THEMES.map((theme) => theme.id)));
    initializeAppearance();
    render(<Fixture />);
    filter("主题集", "favorites");
    fireEvent.click(screen.getByRole("button", { name: "下一页主题" }));
    act(() => {
      localStorage.setItem(FAVORITES_STORAGE_KEY, '["rose"]');
      window.dispatchEvent(new StorageEvent("storage", { key: FAVORITES_STORAGE_KEY }));
    });
    expect(choices().map((radio) => radio.value)).toEqual(["rose"]);
    expect(screen.getByText("1 套 · 第 1 / 1 页")).toBeTruthy();
  });

  it("switches remembered modes and characters independently", () => {
    storeTheme("rose");
    storeTheme("starry");
    const { container } = render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "浅色外观" }));
    expect(getAppearance().theme).toBe("rose");
    fireEvent.click(screen.getByRole("button", { name: "深色外观" }));
    expect(getAppearance().theme).toBe("starry");
    container.querySelector("details")!.open = true;
    fireEvent.click(screen.getByRole("radio", { name: "李白" }));
    expect(getAppearance().character).toBe("human-li-bai");
    expect(getAppearance().theme).toBe("starry");
    expect(container.querySelectorAll(".character-art img")).toHaveLength(9);
  });
});
