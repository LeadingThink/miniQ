// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileEntry } from "./MobileEntry";

const chat = vi.hoisted(() => {
  let release!: () => void;
  return { loaded: vi.fn(), ready: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
});
vi.mock("./MobileChat", async () => {
  chat.loaded();
  await chat.ready;
  return { MobileChat: ({ apiKey, onBack }: { apiKey: string; onBack: () => void }) =>
    <section aria-label="移动问答" data-key={apiKey}><button onClick={onBack}>返回首页</button></section> };
});
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

it("loads chat only after selection and lets the user leave while its code is loading", async () => {
  render(<MobileEntry onRemote={vi.fn()} />);
  expect(chat.loaded).not.toHaveBeenCalled();
  fireEvent.change(screen.getByPlaceholderText("sk-..."), { target: { value: " sk-example " } });
  fireEvent.click(screen.getByRole("checkbox", { name: "我已阅读并同意" }));
  fireEvent.click(screen.getByRole("button", { name: /移动问答/ }));
  await screen.findByText("正在加载移动问答…");
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  await act(async () => chat.release());
  expect(screen.queryByRole("region", { name: "移动问答" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /移动问答/ }));
  const loaded = await screen.findByRole("region", { name: "移动问答" });
  expect(loaded.getAttribute("data-key")).toBe("sk-example");
  expect(chat.loaded).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "返回首页" }));
  expect(screen.getByRole("heading", { name: "随时继续工作" })).toBeTruthy();
});
