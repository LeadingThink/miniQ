// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("./DesktopAccountLogin", () => ({ DesktopAccountLogin: ({ onKey }: { onKey: (key: string) => void }) =>
  <button type="button" onClick={() => onKey("sk-account-fixture")}>获取测试账户 Key</button> }));
import { SettingsPanel, ZAIWEN_API_BASE_URL, DEFAULT_PROVIDER_MODEL } from "./Settings";
afterEach(cleanup);
it("fills the account key, switches to the account service and submits it only on save", async () => {
  const settings = {
    provider: { baseUrl: "https://other.example/v1", model: "other-model", hasApiKey: true },
    remoteAccess: { enabled: false, relayUrl: "", deviceName: "desktop", deviceId: "test" },
    remoteStatus: { state: "disabled", relayUrl: "", mobileClients: 0 },
  };
  const call = vi.fn(async (method: string) => {
    if (method === "settings.providerKey") return { apiKey: "sk-saved-fixture" };
    if (method === "settings.models") return { models: ["other-model"] };
    return settings;
  });
  const client = { mode: "local", call } as unknown as RpcClient;
  render(<SettingsPanel client={client} theme="jade" onThemeChange={() => {}} onClose={() => {}} initialTab="services" />);
  const login = screen.getByRole("button", { name: "使用在问账户登录" });
  await waitFor(() => expect(login.hasAttribute("disabled")).toBe(false));
  fireEvent.click(login);
  fireEvent.click(screen.getByRole("button", { name: "获取测试账户 Key" }));
  const key = screen.getByLabelText("在问 API Key") as HTMLInputElement;
  expect(key.value).toBe("sk-account-fixture"); expect(key.type).toBe("password");
  expect((screen.getByLabelText(/服务地址/) as HTMLInputElement).value).toBe(ZAIWEN_API_BASE_URL);
  expect(call.mock.calls.some(([method]) => method === "settings.update")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "保存并返回" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("settings.update", expect.objectContaining({
    provider: { baseUrl: ZAIWEN_API_BASE_URL, model: DEFAULT_PROVIDER_MODEL, apiProtocol: "auto", apiKey: "sk-account-fixture" },
  })));
});
it("does not offer desktop account login or read the provider secret from remote mode", async () => {
  const call = vi.fn(async () => ({ provider: null, remoteAccess: { enabled: true, deviceName: "desktop" } }));
  render(<SettingsPanel client={{ mode: "remote", call } as unknown as RpcClient} theme="jade"
    onThemeChange={() => {}} onClose={() => {}} initialTab="services" />);
  await waitFor(() => expect(call).toHaveBeenCalledWith("settings.get"));
  expect(screen.queryByRole("button", { name: "使用在问账户登录" })).toBeNull();
  expect(call).not.toHaveBeenCalledWith("settings.providerKey");
});
