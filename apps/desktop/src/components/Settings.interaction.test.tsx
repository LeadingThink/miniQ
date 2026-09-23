// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { getAppearance, initializeAppearance, storeTheme, subscribeAppearance } from "../theme";
import { DEFAULT_PROVIDER_MODEL, SettingsPanel, ZAIWEN_API_BASE_URL } from "./Settings";
import { DEFAULT_RELAY_URL } from "../remoteAccess";

const settings = {
  provider: { baseUrl: "https://example.test/v1", model: "test", apiProtocol: "responses", hasApiKey: true },
  remoteAccess: { enabled: false, relayUrl: "wss://example.test", deviceName: "desktop", deviceId: "test" },
  remoteStatus: { state: "disabled", relayUrl: "", mobileClients: 0 },
};
const call = vi.fn().mockImplementation((method: string) => Promise.resolve(
  method === "model.list" ? { models: ["test", "gpt-5.6-sol", "claude-sonnet"] } : settings,
));
const client = { call, mode: "local", onStatus: () => () => {} } as unknown as RpcClient;

function Fixture({ onClose = () => {} }: { onClose?: () => void }) {
  const { theme } = useSyncExternalStore(subscribeAppearance, getAppearance);
  return <SettingsPanel client={client} theme={theme} onThemeChange={storeTheme} onClose={onClose} />;
}
beforeEach(() => {
  localStorage.clear();
  initializeAppearance();
  call.mockClear().mockImplementation((method: string) => Promise.resolve(
    method === "model.list" ? { models: ["test", "gpt-5.6-sol", "claude-sonnet"] } : settings,
  ));
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
    fireEvent.click(screen.getByRole("tab", { name: "外观" }));
    expect(screen.queryByRole("button", { name: "保存并开始使用" })).toBeNull();
    const night = screen.getByRole("radio", { name: "夜墨" });
    night.focus();
    fireEvent.click(night);
    expect(document.activeElement).toBe(night);
    fireEvent.click(screen.getByRole("button", { name: "收藏夜墨" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "rose" } });
    fireEvent.submit(screen.getByRole("dialog"));
    expect(call.mock.calls.every(([method]) => ["settings.get", "model.list"].includes(method))).toBe(true);
    expect(getAppearance().theme).toBe("night");
  });

  it("keeps the saved model internally, forces automatic protocol, and hides expert fields", async () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    const baseUrl = await screen.findByLabelText(/服务地址/);
    expect((baseUrl as HTMLInputElement).value).toBe("https://example.test/v1");
    const defaultModel = await screen.findByRole("combobox", { name: /默认 Chat 模型/ });
    expect((defaultModel as HTMLSelectElement).value).toBe("test");
    expect(screen.getByRole("option", { name: "gpt-5.6-sol" })).toBeTruthy();
    fireEvent.change(defaultModel, { target: { value: "claude-sonnet" } });
    expect(screen.queryByText("API 协议")).toBeNull();
    expect(screen.queryByLabelText("Relay URL")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "外观" }));
    fireEvent.click(screen.getByRole("radio", { name: "玫瑰" }));
    fireEvent.click(screen.getByRole("tab", { name: "服务与远程" }));
    expect((screen.getByLabelText(/服务地址/) as HTMLInputElement).value).toBe("https://example.test/v1");
    expect(screen.getByRole("link", { name: "获取在问 API Key" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存并开始使用" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("settings.update", {
        provider: { baseUrl: "https://example.test/v1", model: "claude-sonnet", apiProtocol: "auto" },
        remoteAccess: { enabled: false, relayUrl: DEFAULT_RELAY_URL, deviceName: "desktop" },
      })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("falls back to manual model ID only when the model catalog fails", async () => {
    call.mockImplementation((method: string) => {
      if (method === "settings.get") return Promise.resolve(settings);
      if (method === "model.list") return Promise.reject(new Error("catalog unavailable"));
      return Promise.resolve(settings);
    });
    render(<Fixture />);
    expect(await screen.findByText(/模型列表读取失败：catalog unavailable/)).toBeTruthy();
    const input = screen.getByRole("textbox", { name: /默认 Chat 模型/ });
    expect((input as HTMLInputElement).value).toBe("test");
    fireEvent.change(input, { target: { value: "manual-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并开始使用" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("settings.update", expect.objectContaining({
      provider: expect.objectContaining({ model: "manual-model" }),
    })));
  });

  it("persists the optional turn-ended command without exposing it by default", async () => {
    call.mockImplementation((method: string) => Promise.resolve(
      method === "model.list" ? { models: ["test"] } : { ...settings, turnEndedCommand: "say old" },
    ));
    render(<Fixture />);
    await screen.findByText("回合结束命令（可选）");
    const details = document.querySelector("details.turn-ended-hook") as HTMLDetailsElement;
    details.open = true;
    const hook = details.querySelector<HTMLInputElement>("#turn-ended-command")!;
    expect(hook.value).toBe("say old");
    fireEvent.change(hook, { target: { value: "say finished" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并开始使用" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("settings.update", expect.objectContaining({
      turnEndedCommand: "say finished",
    })));
  });

  it("keeps settings open when saving fails", async () => {
    const onClose = vi.fn();
    call.mockImplementation((method: string) => {
      if (method === "settings.get") return Promise.resolve(settings);
      if (method === "model.list") return Promise.resolve({ models: ["test"] });
      return Promise.reject(new Error("update failed"));
    });
    render(<Fixture onClose={onClose} />);
    await screen.findByLabelText(/服务地址/);

    fireEvent.click(screen.getByRole("button", { name: "保存并开始使用" }));

    expect(await screen.findByText("保存失败：update failed")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("defaults first-time setup to Zaiwen and requires only an API key", async () => {
    const empty = { ...settings, provider: null };
    call.mockImplementation((method: string) => Promise.resolve(method === "settings.get" ? empty : method === "model.list" ? { models: [] } : settings));
    render(<Fixture />);
    await waitFor(() => expect((screen.getByLabelText(/服务地址/) as HTMLInputElement).value).toBe(ZAIWEN_API_BASE_URL));
    const save = screen.getByRole("button", { name: "保存并开始使用" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/在问 API Key/), { target: { value: "sk-first-run" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(call).toHaveBeenCalledWith("settings.update", {
      provider: { baseUrl: ZAIWEN_API_BASE_URL, model: DEFAULT_PROVIDER_MODEL, apiProtocol: "auto", apiKey: "sk-first-run" },
      remoteAccess: { enabled: false, relayUrl: DEFAULT_RELAY_URL, deviceName: "desktop" },
    }));
  });

  it("supports tab keyboard navigation and restores focus on close", async () => {
    call.mockImplementation((method: string) => Promise.resolve(method === "computer.permissions" ? {
      platform: "macos",
      processId: 123,
      executable: "/Applications/miniQ.app/Contents/MacOS/miniq-daemon",
      screenRecording: "granted",
      accessibility: "granted",
      displayServer: null,
    } : method === "memory.list" ? { memories: [], nextCursor: null } : method === "model.list" ? { models: ["test"] } : settings));
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(<Fixture />);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole("tab").map((element) => element.textContent)).toEqual([
      "服务与远程", "电脑控制", "外观", "记忆",
    ]);
    fireEvent.keyDown(screen.getByRole("tab", { name: "服务与远程" }), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "电脑控制" }));
    expect(screen.getByRole("region", { name: "电脑控制权限" })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("已授权")).toHaveLength(2));
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "记忆" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "外观" }));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "服务与远程" }));
    expect(screen.getByRole("button", { name: "保存并开始使用" })).toBeTruthy();
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
