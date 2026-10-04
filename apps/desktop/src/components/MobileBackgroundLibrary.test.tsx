// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUNDS } from "../backgroundCatalog";
import { CUSTOM_LIMIT } from "../backgroundRotation";
import { mobileBackgroundPolicy } from "../mobileBackgroundPolicy";
import { MobileBackgroundLibrary } from "./MobileBackgroundLibrary";

beforeEach(() => {
  localStorage.clear();
  mobileBackgroundPolicy.stop();
  mobileBackgroundPolicy.setPreferences({ background: "none", chargingOnly: true, favorites: [], motion: "system", network: "wifi-only", rotation: { enabled: false, playlistId: "timeline", interval: 5, order: "sequence", custom: [], lastSwitchAt: 0 } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); mobileBackgroundPolicy.stop(); });

describe("MobileBackgroundLibrary", () => {
  it("searches, pages, and selects through the mobile policy", () => {
    const select = vi.spyOn(mobileBackgroundPolicy, "selectBackground");
    render(<MobileBackgroundLibrary pageSize={2} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索背景" }), { target: { value: "太空猫" } });
    fireEvent.click(screen.getByRole("radio", { name: "太空猫打盹" }));
    expect(select).toHaveBeenCalledWith("01-spacecat");
    expect(screen.getByText("第 1 / 1 页")).toBeTruthy();
  });

  it("adds and removes a background from the mobile custom collection", () => {
    render(<MobileBackgroundLibrary />);
    const add = screen.getByRole("button", { name: "加入我的合集太空猫打盹" });
    fireEvent.click(add);
    expect(mobileBackgroundPolicy.getSnapshot().preferences.rotation.custom).toEqual(["01-spacecat"]);
    fireEvent.click(screen.getByRole("button", { name: "从我的合集移除太空猫打盹" }));
    expect(mobileBackgroundPolicy.getSnapshot().preferences.rotation.custom).toEqual([]);
  });

  it("keeps favorites independent from the collection and combines filtering with search", () => {
    render(<MobileBackgroundLibrary />);
    fireEvent.click(screen.getByRole("button", { name: "收藏太空猫打盹" }));
    expect(mobileBackgroundPolicy.getSnapshot().preferences.favorites).toEqual(["01-spacecat"]);
    expect(mobileBackgroundPolicy.getSnapshot().preferences.rotation.custom).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /仅看收藏/ }));
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "不存在的背景" } });
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "加入我的合集太空猫打盹" }));
    fireEvent.click(screen.getByRole("button", { name: "取消收藏太空猫打盹" }));
    expect(mobileBackgroundPolicy.getSnapshot().preferences.favorites).toEqual([]);
    expect(mobileBackgroundPolicy.getSnapshot().preferences.rotation.custom).toEqual(["01-spacecat"]);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("clamps the favorites page after removing its last item", () => {
    const favorites = BACKGROUNDS.filter((item) => item.kind !== "none").slice(0, 3);
    mobileBackgroundPolicy.setPreferences({ favorites: favorites.map((item) => item.id) });
    render(<MobileBackgroundLibrary pageSize={2} />);
    fireEvent.click(screen.getByRole("button", { name: /仅看收藏/ }));
    fireEvent.click(screen.getByRole("button", { name: "下一页背景库" }));
    fireEvent.click(screen.getByRole("button", { name: "取消收藏" + favorites[2].name }));
    expect(screen.getByText("第 1 / 1 页")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("updates playlist rotation settings and enforces the custom limit", () => {
    const setPreferences = vi.spyOn(mobileBackgroundPolicy, "setPreferences");
    const custom = BACKGROUNDS.filter((item) => item.kind !== "none").slice(0, CUSTOM_LIMIT).map((item) => item.id);
    mobileBackgroundPolicy.setPreferences({ rotation: { enabled: false, playlistId: "timeline", interval: 5, order: "sequence", custom, lastSwitchAt: 0 } });
    render(<MobileBackgroundLibrary />);
    fireEvent.click(screen.getByRole("checkbox", { name: "合集轮播" }));
    fireEvent.change(screen.getByRole("combobox", { name: "轮播合集" }), { target: { value: "custom" } });
    expect(screen.queryAllByRole("button", { name: /加入我的合集/ })).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: /从我的合集移除/ }).length).toBeGreaterThan(0);
    expect(setPreferences).toHaveBeenCalledWith({ rotation: expect.objectContaining({ enabled: true }) });
    expect(mobileBackgroundPolicy.getSnapshot().preferences.rotation.playlistId).toBe("custom");
    fireEvent.click(screen.getByRole("button", { name: "顺序播放" }));
    expect(mobileBackgroundPolicy.getSnapshot().preferences.rotation.order).toBe("shuffle");
    fireEvent.click(screen.getByRole("button", { name: "随机播放" }));
    expect(mobileBackgroundPolicy.getSnapshot().preferences.rotation.order).toBe("sequence");
  });
});
