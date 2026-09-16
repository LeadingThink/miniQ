// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileEntry } from "./MobileEntry";

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("requires privacy consent before using a key and exposes policy and support before connection", async () => {
  render(<MobileEntry onRemote={() => {}} />);
  expect(screen.getAllByRole("link", { name: /隐私政策/ })[0].getAttribute("href")).toBe("https://chat.zaiwenai.com/miniq/privacy");
  expect(screen.getByRole("link", { name: "技术支持" }).getAttribute("href")).toBe("https://chat.zaiwenai.com/miniq/support");
  const mobileChat = screen.getByRole("button", { name: /移动问答/ }) as HTMLButtonElement;
  expect(mobileChat.disabled).toBe(true);

  fireEvent.change(screen.getByPlaceholderText("sk-..."), { target: { value: "sk-review-key" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "我已阅读并同意" }));
  expect(mobileChat.disabled).toBe(false);
  fireEvent.click(mobileChat);

  await screen.findByText("有什么需要一起完成？");
  await waitFor(() => expect(sessionStorage.getItem("miniq.remote.credentials.v1")).toContain("sk-review-key"));
  expect(localStorage.getItem("miniq.mobile.privacyConsent.v1")).toBe("2026-09-16");
});
