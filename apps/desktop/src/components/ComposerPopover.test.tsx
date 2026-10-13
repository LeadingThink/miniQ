// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { ComposerCard } from "./Composer";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it.each([
  { trigger: "/", label: "斜杠菜单", option: "测试技能" },
  { trigger: "@", label: "文件候选", option: "report.pdf" },
])("places the $trigger menu outside the blurred composer and keeps pointer selection working", async ({ trigger, label, option }) => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 500, bottom: 650, left: 100, right: 700, width: 600, height: 150,
    x: 100, y: 500, toJSON: () => ({}),
  });
  const client = { call: vi.fn(async (method: string) => method === "skill.list"
    ? { skills: [{ name: "测试技能", description: "测试", enabled: true }] }
    : { entries: [{ name: "report.pdf", directory: false }], nextCursor: null }) } as unknown as RpcClient;
  render(<div style={{ backdropFilter: "blur(6px)", overflow: "hidden" }}>
    <ComposerCard busy={false} placeholder="消息" draftKey="popover" sessionId="session" client={client} onSend={vi.fn()} />
  </div>);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: trigger, selectionStart: 1 } });
  const list = await screen.findByRole("listbox", { name: label });
  const menu = list.closest<HTMLElement>(".slash-menu")!;
  expect(menu.parentElement).toBe(document.body);
  expect(menu.style.left).toBe("100px");
  expect(menu.style.top).toBe("492px");
  expect(menu.style.visibility).not.toBe("hidden");
  const item = await screen.findByRole("option", { name: new RegExp(option) });
  fireEvent.pointerDown(item);
  expect(screen.getByRole("listbox", { name: label })).toBeTruthy();
  fireEvent.click(item);
  expect(input.value).toContain(option);
  expect(screen.queryByRole("listbox", { name: label })).toBeNull();
  fireEvent.change(input, { target: { value: trigger, selectionStart: 1 } });
  await screen.findByRole("listbox", { name: label });
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("listbox", { name: label })).toBeNull();
});
