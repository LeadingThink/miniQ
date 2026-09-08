// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { getAppearance, initializeAppearance, storeTheme, subscribeAppearance } from "../theme";
import { SettingsPanel } from "./Settings";

const settings = {
  provider: { baseUrl: "https://example.test/v1", model: "test", apiProtocol: "responses", hasApiKey: true },
  remoteAccess: { enabled: false, relayUrl: "wss://example.test", deviceName: "desktop", deviceId: "test" },
  remoteStatus: { state: "disabled", relayUrl: "", mobileClients: 0 },
};
const call = vi.fn().mockResolvedValue(settings);
const client = { call, mode: "local" } as unknown as RpcClient;

function Fixture({ onClose = () => {} }: { onClose?: () => void }) {
  const { theme } = useSyncExternalStore(subscribeAppearance, getAppearance);
  return <SettingsPanel client={client} theme={theme} onThemeChange={storeTheme} onClose={onClose} />;
}
beforeEach(() => {
  localStorage.clear();
  initializeAppearance();
  call.mockClear().mockResolvedValue(settings);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("appearance settings integration", () => {
  it("ignores backdrop clicks and closes only from an explicit control", async () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    await waitFor(() => expect(call).toHaveBeenCalledWith("settings.get"));

    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog.parentElement!);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not submit provider settings from theme selection, favorites, search or Enter", async () => {
    render(<Fixture />);
    await waitFor(() => expect(call).toHaveBeenCalledWith("settings.get"));
    expect(screen.queryByRole("button", { name: "保存模型设置" })).toBeNull();
    const night = screen.getByRole("radio", { name: "夜墨" });
    night.focus();
    fireEvent.click(night);
    expect(document.activeElement).toBe(night);
    fireEvent.click(screen.getByRole("button", { name: "收藏夜墨" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "rose" } });
    fireEvent.submit(screen.getByRole("dialog"));
    expect(call.mock.calls.every(([method]) => method === "settings.get")).toBe(true);
    expect(getAppearance().theme).toBe("night");
  });

  it("keeps unsaved service fields when switching tabs and submits only on save", async () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    fireEvent.click(screen.getByRole("tab", { name: "服务与远程" }));
    const model = await screen.findByLabelText("Model");
    await waitFor(() => expect((model as HTMLInputElement).value).toBe("test"));
    fireEvent.change(model, { target: { value: "new-model" } });
    fireEvent.click(screen.getByRole("tab", { name: "外观" }));
    fireEvent.click(screen.getByRole("radio", { name: "玫瑰" }));
    fireEvent.click(screen.getByRole("tab", { name: "服务与远程" }));
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("new-model");
    expect(screen.getByRole("link", { name: "获取在问 API Key" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("settings.update", {
        provider: { baseUrl: "https://example.test/v1", model: "new-model", apiProtocol: "responses" },
        remoteAccess: { enabled: false, relayUrl: "wss://example.test", deviceName: "desktop" },
      })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps settings open when saving fails", async () => {
    const onClose = vi.fn();
    call.mockImplementation((method: string) =>
      method === "settings.get" ? Promise.resolve(settings) : Promise.reject(new Error("update failed")),
    );
    render(<Fixture onClose={onClose} />);
    fireEvent.click(screen.getByRole("tab", { name: "服务与远程" }));
    await screen.findByLabelText("Model");

    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    expect(await screen.findByText("保存失败：update failed")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("supports tab keyboard navigation and restores focus on close", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(<Fixture />);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByRole("tab", { name: "外观" }), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "服务与远程" }));
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "外观" }));
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
