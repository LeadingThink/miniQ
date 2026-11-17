// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearZaiwenSession, getZaiwenSession, loginZaiwen, requestZaiwenLoginCode, restoreZaiwenSession } from "./zaiwenAuth";

beforeEach(() => { localStorage.clear(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); });

function response(data: unknown, token = "") {
  return { ok: true, status: 200, headers: new Headers(token ? { token } : {}), json: async () => ({ code: "0", data }) };
}

describe("zaiwen auth", () => {
  it("requests the SMS code using the reference API contract", async () => {
    vi.mocked(fetch).mockResolvedValue(response(null) as Response);
    await requestZaiwenLoginCode("138 0013 8000");
    expect(fetch).toHaveBeenCalledWith("https://back.zaiwenai.com/api/v1/user/sms", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ phone: "13800138000" }),
    }));
  });

  it("persists the token returned by phone login", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ uid: "u1", nick: "用户" }, "token-1") as Response);
    await expect(loginZaiwen("13800138000", "123456")).resolves.toMatchObject({ token: "token-1", user: { uid: "u1" } });
    expect(getZaiwenSession()).toMatchObject({ token: "token-1", user: { uid: "u1" } });
  });

  it("clears an expired persisted session during restore", async () => {
    localStorage.setItem("miniq.zaiwen.token", "expired");
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401, headers: new Headers(), json: async () => ({ msg: "expired" }) } as Response);
    await expect(restoreZaiwenSession()).resolves.toBeNull();
    expect(getZaiwenSession()).toBeNull();
    clearZaiwenSession();
  });

});
