// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ account: vi.fn(), login: vi.fn(), keys: vi.fn(), create: vi.fn(), logout: vi.fn(), sms: vi.fn() }));
vi.mock("../mobileIapAccount", async (original) => ({ ...(await original<typeof import("../mobileIapAccount")>()),
  loadOneApiAccount: mocks.account, loginIapAccount: mocks.login, loadOneApiKeys: mocks.keys,
  createOneApiKey: mocks.create, logoutIapAccount: mocks.logout, requestIapLoginCode: mocks.sms,
}));
import { DesktopAccountLogin, acquireDesktopAccountKey } from "./DesktopAccountLogin";
import { recordMobilePrivacyConsent } from "../mobilePrivacy";
const account = { phone: "13800000000", nick: "Test", balance: 100 };
const key = { key_id: "test", sk: "sk-test", remark: "miniQ", is_active: true, expire_time: 4102444800 };
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  mocks.account.mockResolvedValue(null); mocks.login.mockResolvedValue(account);
  mocks.keys.mockResolvedValue({ total: 0, keys: [] }); mocks.create.mockResolvedValue(key);
});
afterEach(cleanup);
it("logs in and fills a key without submitting the enclosing settings form", async () => {
  recordMobilePrivacyConsent();
  const onKey = vi.fn(); const submit = vi.fn((event) => event.preventDefault());
  render(<form onSubmit={submit}><DesktopAccountLogin disabled={false} onKey={onKey} onBusyChange={() => {}} /></form>);
  const login = screen.getByRole("button", { name: "登录并获取 API Key" });
  await waitFor(() => expect(login.hasAttribute("disabled")).toBe(false));
  fireEvent.change(screen.getByLabelText("手机号（中国大陆）"), { target: { value: "13800000000" } });
  fireEvent.change(screen.getByLabelText("短信验证码"), { target: { value: "123456" } });
  fireEvent.click(login);
  await waitFor(() => expect(onKey).toHaveBeenCalledWith("sk-test"));
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.login).toHaveBeenCalledWith("13800000000", "123456");
  expect(submit).not.toHaveBeenCalled();
  expect(document.querySelectorAll("form")).toHaveLength(1);
});
it("handles Enter inside the embedded login without saving settings", async () => {
  recordMobilePrivacyConsent();
  const submit = vi.fn((event) => event.preventDefault()); const onKey = vi.fn();
  render(<form onSubmit={submit}><DesktopAccountLogin disabled={false} onKey={onKey} onBusyChange={() => {}} /></form>);
  await waitFor(() => expect(screen.getByRole("button", { name: "登录并获取 API Key" }).hasAttribute("disabled")).toBe(false));
  fireEvent.keyDown(screen.getByLabelText("短信验证码"), { key: "Enter" });
  await waitFor(() => expect(onKey).toHaveBeenCalledWith("sk-test"));
  expect(submit).not.toHaveBeenCalled();
});
it("does not apply an asynchronous key result after closing the account panel", async () => {
  mocks.account.mockResolvedValue(account);
  let resolveKeys!: (value: unknown) => void;
  mocks.keys.mockImplementation(() => new Promise((resolve) => { resolveKeys = resolve; }));
  const onKey = vi.fn();
  const { unmount } = render(<DesktopAccountLogin disabled={false} onKey={onKey} onBusyChange={() => {}} />);
  const getKey = await screen.findByRole("button", { name: "获取账户 API Key" });
  await waitFor(() => expect(getKey.hasAttribute("disabled")).toBe(false));
  fireEvent.click(getKey);
  unmount();
  resolveKeys({ total: 1, keys: [key] });
  await Promise.resolve(); await Promise.resolve();
  expect(onKey).not.toHaveBeenCalled();
});
it("searches later pages and ignores disabled and expired keys", async () => {
  mocks.keys.mockResolvedValueOnce({ total: 3, keys: [{ ...key, is_active: false }, { ...key, expire_time: 1 }] })
    .mockResolvedValueOnce({ total: 3, keys: [key] });
  await expect(acquireDesktopAccountKey()).resolves.toBe("sk-test");
  expect(mocks.keys).toHaveBeenNthCalledWith(2, 2);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("does not create a key when listing fails or returns an incomplete page", async () => {
  mocks.keys.mockRejectedValueOnce(new Error("network"));
  await expect(acquireDesktopAccountKey()).rejects.toThrow("network");
  mocks.keys.mockResolvedValueOnce({ total: 10, keys: [] });
  await expect(acquireDesktopAccountKey()).rejects.toThrow("列表加载不完整");
  expect(mocks.create).not.toHaveBeenCalled();
});
it("restores an account without silently replacing the manual key, and logout preserves it", async () => {
  mocks.account.mockResolvedValue(account);
  const onKey = vi.fn();
  render(<DesktopAccountLogin disabled={false} onKey={onKey} onBusyChange={() => {}} />);
  await screen.findByText(/当前账户：13800000000/);
  const logout = screen.getByRole("button", { name: "退出账户登录" });
  await waitFor(() => expect(logout.hasAttribute("disabled")).toBe(false));
  expect(onKey).not.toHaveBeenCalled(); expect(mocks.keys).not.toHaveBeenCalled();
  fireEvent.click(logout);
  await screen.findByText("已退出账户登录。已保存的 API Key 仍可使用。");
  expect(onKey).not.toHaveBeenCalled();
});
it("reports acquisition failures while retaining the authenticated account for retry", async () => {
  recordMobilePrivacyConsent(); mocks.keys.mockRejectedValue(new Error("Key 服务不可用"));
  const onKey = vi.fn();
  render(<DesktopAccountLogin disabled={false} onKey={onKey} onBusyChange={() => {}} />);
  const login = screen.getByRole("button", { name: "登录并获取 API Key" });
  await waitFor(() => expect(login.hasAttribute("disabled")).toBe(false));
  fireEvent.click(login);
  await screen.findByRole("alert");
  expect(screen.getByText("Key 服务不可用")).toBeTruthy();
  expect(screen.getByRole("button", { name: "获取账户 API Key" })).toBeTruthy();
  expect(onKey).not.toHaveBeenCalled();
});
it("explains missing consent on SMS click and only sends after explicit consent", async () => {
  render(<DesktopAccountLogin disabled={false} onKey={vi.fn()} onBusyChange={() => {}} />);
  const send = screen.getByRole("button", { name: "发送验证码" });
  await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
  fireEvent.change(screen.getByLabelText("手机号（中国大陆）"), { target: { value: "13800000000" } });
  fireEvent.click(send);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "请先阅读并同意隐私政策。");
  expect(mocks.sms).not.toHaveBeenCalled();
  const consent = screen.getByRole("checkbox");
  expect((consent as HTMLInputElement).checked).toBe(false);
  fireEvent.click(consent);
  fireEvent.click(send);
  await waitFor(() => expect(mocks.sms).toHaveBeenCalledWith("13800000000"));
  expect(await screen.findByRole("button", { name: "60 秒后重新发送" })).toBeTruthy();
});
