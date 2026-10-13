// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), load: vi.fn(), account: vi.fn(), login: vi.fn(), sms: vi.fn(), keys: vi.fn(), create: vi.fn(), logout: vi.fn() }));
vi.mock("../remoteAccess", () => ({ isRememberEnabled: () => true, readRemoteCredentials: () => null,
  loadRemoteCredentials: mocks.load, storeRemoteCredentials: mocks.save, setRememberEnabled: vi.fn() }));
vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => true }));
vi.mock("./MobileAppearanceSheet", () => ({ useMobileBackButton: vi.fn(), MobileAppearanceSheet: () => null }));
vi.mock("./MobileUpdateCheck", () => ({ MobileUpdateCheck: () => null }));
vi.mock("../iosIap", () => ({ isIosIapAvailable: () => true }));
vi.mock("./MobilePurchasePanel", () => ({ MobilePurchasePanel: () => <div>Apple 购买区域</div> }));
vi.mock("../mobileIapAccount", async (original) => ({ ...(await original<typeof import("../mobileIapAccount")>()),
  loadOneApiAccount: mocks.account, loginIapAccount: mocks.login, requestIapLoginCode: mocks.sms,
  loadOneApiKeys: mocks.keys, createOneApiKey: mocks.create, logoutIapAccount: mocks.logout,
}));
import { MobileEntry } from "./MobileEntry";
import { MobileAccountPanel } from "./MobileAccountPanel";
import { recordMobilePrivacyConsent } from "../mobilePrivacy";
const account = { phone: "13800000000", nick: "Test", balance: 100 };
const newKey = { key_id: "new", sk: "sk-created", remark: "miniQ", is_active: true, expire_time: 2000000000 };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  mocks.load.mockResolvedValue(null); mocks.save.mockResolvedValue(undefined);
  mocks.account.mockResolvedValue(null); mocks.login.mockResolvedValue(account);
  mocks.keys.mockResolvedValue({ total: 0, keys: [] }); mocks.create.mockResolvedValue(newKey);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(cleanup);
it("accepts an existing website Key on iOS without login or purchase", async () => {
  render(<MobileEntry onRemote={() => {}} />);
  const input = screen.getByLabelText("在问 API Key");
  await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
  fireEvent.change(input, { target: { value: "sk-website" } });
  fireEvent.click(screen.getByLabelText("我已阅读并同意"));
  fireEvent.click(screen.getByRole("button", { name: "保存 Key 并继续" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-website" }), { remember: true }));
  expect(mocks.login).not.toHaveBeenCalled(); expect(mocks.account).not.toHaveBeenCalled();
  expect(screen.queryByText("Apple 购买区域")).toBeNull();
});
it("opens login below the Key field without linking to external payment, and preserves the manual input", async () => {
  render(<MobileEntry onRemote={() => {}} />);
  const input = screen.getByLabelText("在问 API Key");
  await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
  fireEvent.change(input, { target: { value: "sk-draft" } });
  expect(document.querySelector('a[href="https://platform.zaiwenai.com/"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "没有 API Key？登录购买额度 / 创建 Key" }));
  expect(screen.getByRole("heading", { name: "手机号登录" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "返回填写 API Key" }));
  expect((screen.getByLabelText("在问 API Key") as HTMLInputElement).value).toBe("sk-draft");
  expect(mocks.save).not.toHaveBeenCalled();
});
it("allows manual key creation and copying after phone login without activating or saving it", async () => {
  recordMobilePrivacyConsent();
  render(<MobileAccountPanel onBack={() => {}} onBusyChange={() => {}} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "登录" }).hasAttribute("disabled")).toBe(false));
  fireEvent.change(screen.getByLabelText("手机号（中国大陆）"), { target: { value: "13800000000" } });
  fireEvent.change(screen.getByLabelText("短信验证码"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  await screen.findByText("Apple 购买区域");
  await waitFor(() => expect(screen.getByRole("button", { name: "创建 API Key" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "创建 API Key" }));
  await screen.findByText("Key 已创建，请复制保存。");
  const copy = screen.getByRole("button", { name: "复制 Key" });
  await waitFor(() => expect(copy.hasAttribute("disabled")).toBe(false));
  fireEvent.click(copy);
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("sk-created"));
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.login).toHaveBeenCalledWith("13800000000", "123456");
});
it("restores a cookie account and paginates existing Keys", async () => {
  recordMobilePrivacyConsent(); mocks.account.mockResolvedValue(account);
  mocks.keys.mockResolvedValueOnce({ total: 11, keys: [newKey] }).mockResolvedValueOnce({ total: 11, keys: [{ ...newKey, key_id: "last", remark: "末页" }] });
  render(<MobileAccountPanel onBack={() => {}} onBusyChange={() => {}} />);
  await screen.findByText("miniQ");
  const next = screen.getByRole("button", { name: "下一页" });
  await waitFor(() => expect(next.hasAttribute("disabled")).toBe(false));
  fireEvent.click(next);
  await screen.findByText("末页"); expect(mocks.keys).toHaveBeenLastCalledWith(2);
});
