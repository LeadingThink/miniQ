import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ keys: vi.fn(), create: vi.fn() }));
vi.mock("./mobileIapAccount", () => ({ loadOneApiKeys: mocks.keys, createOneApiKey: mocks.create }));
import { acquireDesktopAccountKey, isUsableDesktopAccountKey, loadDesktopAccountKeys } from "./desktopAccountKey";
const key = { sk: "sk-fixture", is_active: true, expire_time: 2000000000 };
beforeEach(() => vi.resetAllMocks());

it("preserves the main-site session for later pages and reuses the existing valid key", async () => {
  mocks.keys.mockResolvedValueOnce({ total: 2, keys: [{ ...key, is_active: false }] })
    .mockResolvedValueOnce({ total: 2, keys: [key] });
  await expect(acquireDesktopAccountKey("session-a")).resolves.toBe("sk-fixture");
  expect(mocks.keys.mock.calls).toEqual([[1, "session-a"], [2, "session-a"]]);
  expect(mocks.create).not.toHaveBeenCalled();
});

it("creates exactly one key in the same isolated session after exhausting all pages", async () => {
  mocks.keys.mockResolvedValueOnce({ total: 1, keys: [{ ...key, expire_time: 1 }] });
  mocks.create.mockResolvedValue(key);
  await expect(acquireDesktopAccountKey("session-a")).resolves.toBe("sk-fixture");
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith("miniQ 桌面端", "session-a");
});

it("does not create a key when cancellation arrives during key listing", async () => {
  const cancellation = new AbortController();
  mocks.keys.mockImplementation(async () => { cancellation.abort(); return { total: 0, keys: [] }; });
  await expect(acquireDesktopAccountKey("session-a", cancellation.signal)).rejects.toThrow();
  expect(mocks.create).not.toHaveBeenCalled();
});

it("loads every page and keeps disabled and expired keys visible in the picker", async () => {
  const later = { ...key, key_id: "later", sk: "sk-later" };
  const disabled = { ...key, is_active: false };
  const expired = { ...key, expire_time: 1 };
  mocks.keys.mockResolvedValueOnce({ total: 4, keys: [key, disabled] })
    .mockResolvedValueOnce({ total: 4, keys: [later, expired] });
  await expect(loadDesktopAccountKeys("session-a")).resolves.toEqual([key, disabled, later, expired]);
  expect(mocks.keys.mock.calls).toEqual([[1, "session-a"], [2, "session-a"]]);
  expect(mocks.create).not.toHaveBeenCalled();
});

it("refuses an incomplete list instead of silently omitting remaining choices", async () => {
  mocks.keys.mockResolvedValueOnce({ total: 2, keys: [key] })
    .mockResolvedValueOnce({ total: 2, keys: [] });
  await expect(loadDesktopAccountKeys("session-a")).rejects.toThrow("列表加载不完整");
  expect(mocks.create).not.toHaveBeenCalled();
});

it("only enables active and unexpired keys", () => {
  const complete = { ...key, key_id: "first", remark: "Test" };
  expect(isUsableDesktopAccountKey(complete)).toBe(true);
  expect(isUsableDesktopAccountKey({ ...complete, is_active: false })).toBe(false);
  expect(isUsableDesktopAccountKey({ ...complete, expire_time: 1 })).toBe(false);
});
