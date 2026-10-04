// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUNDS } from "../backgroundCatalog";
import { mobileBackgroundPolicy } from "../mobileBackgroundPolicy";
import { MobileAppearanceSheet } from "./MobileAppearanceSheet";

const pageCount = Math.ceil(BACKGROUNDS.length / 12);

beforeEach(() => {
  localStorage.clear();
  mobileBackgroundPolicy.stop();
  mobileBackgroundPolicy.setPreferences({ background: "none", chargingOnly: true, favorites: [], rotation: { enabled: false, playlistId: "timeline", interval: 5, order: "sequence", custom: [], lastSwitchAt: 0 }, motion: "system", network: "wifi-only" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); mobileBackgroundPolicy.stop(); });

describe("MobileAppearanceSheet", () => {
  it("focuses the dialog and closes with Escape", () => {
    const onClose = vi.fn();
    render(<MobileAppearanceSheet onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("browses the complete catalog and selects through the mobile policy", () => {
    const selectBackground = vi.spyOn(mobileBackgroundPolicy, "selectBackground");
    render(<MobileAppearanceSheet />);
    expect(screen.getByText(`第 1 / ${pageCount} 页`)).toBeTruthy();
    for (let page = 1; page < pageCount; page += 1) fireEvent.click(screen.getByRole("button", { name: "下一页背景库" }));
    expect(screen.getByText(`第 ${pageCount} / ${pageCount} 页`)).toBeTruthy();
    expect(screen.getAllByRole("combobox", { name: "轮播间隔" })).toHaveLength(1);
    expect(screen.queryByRole("radiogroup", { name: "背景目录" })).toBeNull();
    const lastItem = BACKGROUNDS[BACKGROUNDS.length - 1];
    fireEvent.click(screen.getByRole("radio", { name: lastItem.name }));
    expect(selectBackground).toHaveBeenCalledWith(lastItem.id);
  });

  it("reads and updates independent mobile motion, network, and rotation preferences", () => {
    const setPreferences = vi.spyOn(mobileBackgroundPolicy, "setPreferences");
    render(<MobileAppearanceSheet />);
    fireEvent.click(screen.getByRole("radio", { name: "低功耗" }));
    fireEvent.click(screen.getByRole("radio", { name: "Wi-Fi 与移动网络" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "合集轮播" }));
    expect(setPreferences).toHaveBeenCalledWith({ motion: "low-power" });
    expect(setPreferences).toHaveBeenCalledWith({ network: "cellular-opt-in" });
    expect(setPreferences).toHaveBeenCalledWith({ rotation: expect.objectContaining({ enabled: true }) });
  });

  it("defaults to charging-only playback and persists the toggle", () => {
    render(<MobileAppearanceSheet />);
    const toggle = screen.getByRole("checkbox", { name: "仅充电时播放" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(mobileBackgroundPolicy.getSnapshot().preferences.chargingOnly).toBe(false);
    fireEvent.click(toggle);
    expect(mobileBackgroundPolicy.getSnapshot().preferences.chargingOnly).toBe(true);
  });

  it("subscribes to cache status and reports clear failures", async () => {
    const clearVideoCache = vi.spyOn(mobileBackgroundPolicy, "clearVideoCache").mockRejectedValue(new Error("unavailable"));
    vi.spyOn(mobileBackgroundPolicy, "getVideoStatus").mockReturnValue({ status: "cached", bytes: 2 * 1024 * 1024 });
    render(<MobileAppearanceSheet />);
    await screen.findByText(new RegExp(`${BACKGROUNDS.filter((item) => item.kind === "video").length} 个视频`));
    fireEvent.click(screen.getByRole("button", { name: "清理缓存" }));
    expect(clearVideoCache).toHaveBeenCalledOnce();
    expect((await screen.findByRole("alert")).textContent).toContain("清理缓存失败");
  });

  it("surfaces a real mobile policy download failure", async () => {
    vi.spyOn(mobileBackgroundPolicy, "retryVideo").mockRejectedValue(new Error("offline"));
    render(<MobileAppearanceSheet />);
    const item = BACKGROUNDS.find((item) => item.kind === "video")!;
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: item.name } });
    fireEvent.click(screen.getByRole("radio", { name: item.name }));
    fireEvent.click(screen.getAllByRole("button", { name: /下载「/ })[0]);
    expect((await screen.findByRole("alert")).textContent).toContain("下载失败");
  });
  it("allows a cached video to retry playback through the explicit retry API", async () => {
    const retryVideo = vi.spyOn(mobileBackgroundPolicy, "retryVideo").mockResolvedValue(new Blob(["video"]));
    const downloadVideo = vi.spyOn(mobileBackgroundPolicy, "downloadVideo");
    vi.spyOn(mobileBackgroundPolicy, "getVideoStatus").mockReturnValue({ status: "cached", bytes: 5 });
    render(<MobileAppearanceSheet />);
    const videoIndex = BACKGROUNDS.findIndex((item) => item.kind === "video");
    const item = BACKGROUNDS[videoIndex];
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: item.name } });
    fireEvent.click(screen.getByRole("radio", { name: item.name }));
    const button = screen.getByRole("button", { name: `重试播放「${item.name}」` });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(retryVideo).toHaveBeenCalledWith(item.video));
    expect(downloadVideo).not.toHaveBeenCalled();
  });

});
