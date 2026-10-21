// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_STORAGE_KEY, getActiveBackground, initializeBackground, storeBackground } from "../background";
import { BACKGROUNDS } from "../backgroundCatalog";
import { getRotation, resetRotationForTest, ROTATION_STORAGE_KEY } from "../backgroundRotation";
import { BackgroundPicker, PAGE_SIZE } from "./BackgroundPicker";
import { LivingBackground } from "./LivingBackground";

beforeEach(() => {
  localStorage.clear();
  initializeBackground();
  resetRotationForTest();
});
afterEach(() => {
  cleanup();
  resetRotationForTest();
  vi.unstubAllGlobals();
});

const radios = () =>
  within(screen.getByRole("radiogroup", { name: "背景" })).getAllByRole("radio") as HTMLInputElement[];

describe("background picker", () => {
  it("defaults to the plain interface and pages through every background once", () => {
    render(<BackgroundPicker />);
    expect(radios()).toHaveLength(PAGE_SIZE);
    while (screen.queryByRole("button", { name: /显示更多/ })) {
      fireEvent.click(screen.getByRole("button", { name: /显示更多/ }));
    }
    const values = radios().map((radio) => radio.value);
    expect(values).toEqual(BACKGROUNDS.map((item) => item.id));
    expect((screen.getByRole("radio", { name: "纯净界面" }) as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.dataset.background).toBeUndefined();
  });

  it("filters by tab and search", () => {
    render(<BackgroundPicker />);
    fireEvent.click(screen.getByRole("tab", { name: "动物伙伴" }));
    expect(radios()).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: "全部" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索壁纸" }), { target: { value: "深海慢游" } });
    expect(radios().map((radio) => radio.value)).toEqual(["quiet-whale"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索壁纸" }), { target: { value: "zzzz" } });
    expect(screen.getByText("没有找到匹配的背景，换个关键词试试")).toBeTruthy();
  });

  it("persists the choice and mirrors it on the root element", () => {
    render(<BackgroundPicker />);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索壁纸" }), { target: { value: "深海慢游" } });
    fireEvent.click(screen.getByRole("radio", { name: "深海慢游" }));
    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBe("quiet-whale");
    expect(document.documentElement.dataset.background).toBe("quiet-whale");
    expect(document.documentElement.dataset.backgroundKind).toBe("video");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索壁纸" }), { target: { value: "奶杏几何" } });
    fireEvent.click(screen.getByRole("radio", { name: "奶杏几何" }));
    expect(document.documentElement.dataset.backgroundTone).toBe("light");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索壁纸" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "纯净界面" }));
    expect(document.documentElement.dataset.background).toBeUndefined();
  });

  it("collects backgrounds and controls rotation", () => {
    render(<BackgroundPicker />);
    fireEvent.click(screen.getByRole("button", { name: "把深海慢游加入我的合集" }));
    expect(getRotation().custom).toEqual(["quiet-whale"]);
    fireEvent.click(screen.getByRole("tab", { name: "我的合集 1" }));
    expect(radios().map((radio) => radio.value)).toEqual(["quiet-whale"]);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "壁纸合集" })).getByRole("radio", { name: "我的合集" }));
    fireEvent.click(screen.getByTestId("rotation-toggle"));
    expect(getRotation()).toMatchObject({ enabled: true, playlistId: "custom" });
    expect(getActiveBackground().id).toBe("quiet-whale");
    fireEvent.change(screen.getByRole("combobox", { name: "轮播间隔" }), { target: { value: "30" } });
    expect(JSON.parse(localStorage.getItem(ROTATION_STORAGE_KEY)!).interval).toBe(30);
    fireEvent.click(screen.getByRole("button", { name: "把深海慢游移出我的合集" }));
    expect(getRotation().custom).toEqual([]);
    expect(screen.getByText("我的合集还是空的。在壁纸卡片上点「+」加入。")).toBeTruthy();
  });

  it("ignores unknown stored values", () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, "missing");
    initializeBackground();
    expect(getActiveBackground().id).toBe("none");
  });
});

describe("living background", () => {
  it("renders nothing by default", () => {
    const { container } = render(<LivingBackground />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps the remote cover when the video cannot be downloaded", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    localStorage.setItem(BACKGROUND_STORAGE_KEY, "14-fishing");
    initializeBackground();
    const { container } = render(<LivingBackground />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const poster = container.querySelector("img.living-background-poster") as HTMLImageElement;
    expect(poster.getAttribute("src")).toMatch(/14-fishing\.jpg$/);
    expect(container.querySelector("video")).toBeNull();
  });

  it("crossfades to the next background on a separate layer", () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, "14-fishing");
    initializeBackground();
    const { container } = render(<LivingBackground />);
    expect(container.querySelectorAll(".living-background-layer")).toHaveLength(1);
    act(() => storeBackground("quiet-moonwater"));
    const layers = container.querySelectorAll(".living-background-layer");
    expect(layers).toHaveLength(2);
    expect(layers[0]!.classList.contains("is-leaving")).toBe(true);
    expect(layers[1]!.classList.contains("is-entering")).toBe(true);
  });
});
