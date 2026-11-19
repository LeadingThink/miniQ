import { beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "./rpc";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), keys: vi.fn(), create: vi.fn(), native: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./runtime", () => ({ isTauriRuntime: () => mocks.native }));
vi.mock("./desktopAccountKey", async (original) => ({ ...(await original<typeof import("./desktopAccountKey")>()), loadDesktopAccountKeys: mocks.keys }));
vi.mock("./mobileIapAccount", () => ({ createOneApiKey: mocks.create }));
import { hasZaiwenKey, loadZaiwenImportKeys, selectZaiwenKey, zaiwenSessionStatus, type ImportProvider } from "./zaiwenKeyImport";

const provider: ImportProvider = { baseUrl: "https://other.test/v1", model: "custom", apiProtocol: "responses", hasApiKey: true };
const key = { key_id: "first", sk: "sk-first-fixture", remark: "First", is_active: true, expire_time: 4102444800 };
const second = { ...key, key_id: "second", sk: "sk-second-fixture" };
const call = vi.fn();
const client = { mode: "local", call } as unknown as RpcClient;
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks(); mocks.native = true;
  mocks.invoke.mockImplementation(async (name) => name === "zaiwen_session_status"
    ? { supported: true, sessionId: "session-a" } : undefined);
  mocks.keys.mockResolvedValue([key, second]);
  mocks.create.mockResolvedValue(key);
  call.mockResolvedValue({ provider });
});

it("authenticates with SSO and lists all choices without creating a key or changing settings", async () => {
  await expect(loadZaiwenImportKeys(client, "session-a", signal())).resolves.toEqual([key, second]);
  expect(mocks.invoke).toHaveBeenCalledWith("zaiwen_account_login", { sessionId: "session-a" });
  expect(mocks.keys).toHaveBeenCalledWith("session-a", expect.any(AbortSignal));
  expect(mocks.create).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
});

it("returns exactly the selected key without changing miniQ settings", async () => {
  await expect(selectZaiwenKey(client, "session-a", signal(), "second")).resolves.toEqual(second);
  expect(call).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});

it("creates one only when the list is still empty and creation was confirmed", async () => {
  mocks.keys.mockResolvedValue([]);
  await expect(selectZaiwenKey(client, "session-a", signal(), null)).resolves.toEqual(key);
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith("miniQ 桌面端", "session-a");
  expect(call).not.toHaveBeenCalled();
});

it("never silently substitutes or creates a key when a selected key disappears", async () => {
  await expect(selectZaiwenKey(client, "session-a", signal(), "removed")).rejects.toThrow("所选 API Key 已不可用");
  expect(mocks.create).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
});

it("never saves a selected key that has since expired or been disabled", async () => {
  for (const unavailable of [{ ...key, is_active: false }, { ...key, expire_time: 1 }]) {
    mocks.keys.mockResolvedValue([unavailable]);
    await expect(selectZaiwenKey(client, "session-a", signal(), "first")).rejects.toThrow("所选 API Key 已不可用");
  }
  expect(mocks.create).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
});

it("asks for a new selection if keys appear after an empty list was shown", async () => {
  await expect(selectZaiwenKey(client, "session-a", signal(), null)).rejects.toThrow("列表已变化");
  expect(mocks.create).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
});

it("does not save after the main-site account changes", async () => {
  mocks.invoke.mockResolvedValue({ supported: true, sessionId: "session-b" });
  await expect(selectZaiwenKey(client, "session-a", signal(), "first")).rejects.toThrow("账号已变化");
  expect(call).not.toHaveBeenCalled();
});

it("does not create a key for an account that changed before creation", async () => {
  mocks.keys.mockResolvedValue([]);
  mocks.invoke.mockResolvedValue({ supported: true, sessionId: "session-b" });
  await expect(selectZaiwenKey(client, "session-a", signal(), null)).rejects.toThrow("账号已变化");
  expect(mocks.create).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
});

it("rejects the result if the account changes during creation", async () => {
  mocks.keys.mockResolvedValue([]);
  mocks.create.mockImplementation(async () => {
    mocks.invoke.mockResolvedValue({ supported: true, sessionId: "session-b" });
    return key;
  });
  await expect(selectZaiwenKey(client, "session-a", signal(), null)).rejects.toThrow("账号已变化");
  expect(mocks.create).toHaveBeenCalledOnce(); expect(call).not.toHaveBeenCalled();
});

it("honors cancellation while checking the account before creation", async () => {
  mocks.keys.mockResolvedValue([]);
  const cancellation = new AbortController();
  mocks.invoke.mockImplementation(async () => {
    cancellation.abort();
    return { supported: true, sessionId: "session-a" };
  });
  await expect(selectZaiwenKey(client, "session-a", cancellation.signal, null)).rejects.toThrow();
  expect(mocks.create).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
});

it("does not save or create more keys after cancellation", async () => {
  const cancellation = new AbortController();
  mocks.keys.mockImplementation(async () => { cancellation.abort(); return [key]; });
  await expect(selectZaiwenKey(client, "session-a", cancellation.signal, "first")).rejects.toThrow();
  expect(call).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});

it("never starts SSO or saves for browser preview, relay clients, or SSH targets", async () => {
  for (const target of [{ mode: "remote" }, { mode: "local", sshHost: "server" }]) {
    const remote = { ...target, call } as unknown as RpcClient;
    await expect(loadZaiwenImportKeys(remote, "session-a", signal())).rejects.toThrow("本机");
    await expect(selectZaiwenKey(remote, "session-a", signal(), "first")).rejects.toThrow("本机");
  }
  mocks.native = false;
  expect(await zaiwenSessionStatus()).toEqual({ supported: false, sessionId: null });
  await expect(loadZaiwenImportKeys(client, "session-a", signal())).rejects.toThrow("本机");
  await expect(selectZaiwenKey(client, "session-a", signal(), "first")).rejects.toThrow("本机");
  expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.keys).not.toHaveBeenCalled();
});

it("propagates an SSO failure without accessing or overwriting a key from another account", async () => {
  mocks.invoke.mockRejectedValue("主站登录已过期，请重新登录在问。");
  await expect(loadZaiwenImportKeys(client, "session-a", signal())).rejects.toThrow("主站登录已过期");
  expect(mocks.keys).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
});

it("only treats an existing key on the official endpoint as a configured Zaiwen key", () => {
  expect(hasZaiwenKey({ ...provider, baseUrl: "https://oneapi.zaiwenai.com/v1/" })).toBe(true);
  expect(hasZaiwenKey(provider)).toBe(false);
  expect(hasZaiwenKey({ ...provider, baseUrl: "https://oneapi.zaiwenai.com/v1", hasApiKey: false })).toBe(false);
  expect(hasZaiwenKey(null)).toBe(false);
});
