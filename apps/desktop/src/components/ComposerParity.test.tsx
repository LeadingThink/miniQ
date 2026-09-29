// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { Message } from "../types";
import { COMPOSER_PLACEHOLDER } from "../composerInput";
import { dispatchComposerInsert } from "../composerMention";
import { Composer, ComposerCard } from "./Composer";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const listings: Record<string, { name: string; directory: boolean }[]> = {
  "": [
    { name: "src", directory: true },
    { name: "node_modules", directory: true },
    { name: "README.md", directory: false },
    { name: "my notes.md", directory: false },
  ],
  src: [{ name: "App.tsx", directory: false }],
};

function fakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const call = vi.fn(async (method: string, params?: { path?: string }) => {
    if (method === "file.list") {
      const path = params?.path ?? "";
      if (!(path in listings)) throw new Error("只能浏览当前会话的项目目录");
      return {
        path,
        parent: null,
        roots: ["/repo"],
        entries: listings[path].map((entry) => ({ ...entry, path: `/repo/${path}/${entry.name}`, size: 1 })),
        nextCursor: null,
      };
    }
    return {};
  });
  return { client: { call, ...overrides } as unknown as RpcClient, call };
}

function renderCard(props: Partial<Parameters<typeof ComposerCard>[0]> = {}) {
  const onSend = vi.fn().mockResolvedValue(true);
  render(
    <ComposerCard busy={false} placeholder="消息" draftKey="parity" onSend={onSend} {...props} />,
  );
  return { input: screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }), onSend };
}

it("offers project files for @ and inserts the relative path", async () => {
  const { client, call } = fakeClient();
  const { input } = renderCard({ client, sessionId: "s1" });
  fireEvent.change(input, { target: { value: "看看 @app" } });
  const option = await screen.findByRole("option", { name: /App\.tsx/ });
  expect(option.getAttribute("aria-selected")).toBe("true");
  expect(call).toHaveBeenCalledWith("file.list", { sessionId: "s1", path: "", after: null });
  expect(call).not.toHaveBeenCalledWith("file.list", expect.objectContaining({ path: "node_modules" }));
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("看看 @src/App.tsx ");
  expect(localStorage.getItem("miniq.draft.parity")).toBe("看看 @src/App.tsx ");
  expect(screen.queryByRole("listbox", { name: "文件候选" })).toBeNull();
});

it("quotes paths with spaces, navigates with arrows and closes with Escape", async () => {
  const { client } = fakeClient();
  const { input, onSend } = renderCard({ client, sessionId: "s2" });
  fireEvent.change(input, { target: { value: "@" } });
  await screen.findByRole("option", { name: /README\.md/ });
  fireEvent.change(input, { target: { value: "@notes" } });
  await screen.findByRole("option", { name: /my notes\.md/ });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input.value).toBe("@`my notes.md` ");

  fireEvent.change(input, { target: { value: "x @" } });
  await screen.findByRole("option", { name: /README\.md/ });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox", { name: "文件候选" })).toBeNull();
  // With the popover closed Enter sends normally.
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  expect(onSend).toHaveBeenCalledWith("x @", []);
});

it("does not trigger for e-mail addresses or pick during IME composition", async () => {
  const { client, call } = fakeClient();
  const { input } = renderCard({ client, sessionId: "s3" });
  fireEvent.change(input, { target: { value: "me@example" } });
  expect(screen.queryByRole("listbox", { name: "文件候选" })).toBeNull();
  expect(call).not.toHaveBeenCalledWith("file.list", expect.anything());

  fireEvent.change(input, { target: { value: "@read" } });
  await screen.findByRole("option", { name: /README\.md/ });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(input.value).toBe("@read");
});

it("shows a Chinese error when the project cannot be listed", async () => {
  const call = vi.fn(async (method: string) => {
    if (method === "file.list") throw new Error("只能浏览当前会话的项目目录");
    return {};
  });
  const { input } = renderCard({ client: { call } as unknown as RpcClient, sessionId: "s4" });
  fireEvent.change(input, { target: { value: "@" } });
  expect((await screen.findByRole("alert")).textContent).toContain("只能浏览当前会话的项目目录");
});

it("inserts bus text at the caret when focused and appends otherwise", () => {
  const { input } = renderCard();
  fireEvent.change(input, { target: { value: "开头" } });
  input.blur();
  act(() => dispatchComposerInsert("> 引用\n\n"));
  expect(input.value).toBe("开头\n\n> 引用\n\n");
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(input.value.length);
  expect(localStorage.getItem("miniq.draft.parity")).toBe(input.value);

  input.setSelectionRange(2, 2);
  act(() => dispatchComposerInsert("中"));
  expect(input.value.startsWith("开头中\n\n")).toBe(true);
  expect(input.selectionStart).toBe(3);
});

it("delivers bus text only to one visible composer", () => {
  render(
    <div hidden>
      <ComposerCard busy={false} placeholder="隐藏" draftKey="hidden" onSend={vi.fn()} />
    </div>,
  );
  const { input } = renderCard();
  const hidden = screen.getByPlaceholderText<HTMLTextAreaElement>("隐藏");
  act(() => dispatchComposerInsert("你好"));
  expect(input.value).toBe("你好");
  expect(hidden.value).toBe("");
});

it("recalls this session's last user message with ArrowUp in an empty input", () => {
  const messages = [
    { id: "1", sessionId: "s5", role: "user", content: "第一条", createdAt: "" },
    { id: "2", sessionId: "s5", role: "user", content: "最后一条", createdAt: "" },
    { id: "3", sessionId: "s5", role: "assistant", content: "回复", createdAt: "" },
  ] as Message[];
  const { input } = renderCard({ sessionId: "s5", messages });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("最后一条");
  expect(input.selectionStart).toBe(4);

  fireEvent.change(input, { target: { value: "已有" } });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("已有");
});

it("keeps ArrowUp default without history", () => {
  const { input } = renderCard({ messages: [] });
  expect(fireEvent.keyDown(input, { key: "ArrowUp" })).toBe(true);
  expect(input.value).toBe("");
});

it.each([{ metaKey: true }, { ctrlKey: true }])("opens the attachment picker with %j+U", (modifier) => {
  const { client } = fakeClient({ mode: "remote", sshHost: "devbox" });
  const { input } = renderCard({ client });
  fireEvent.keyDown(input, { key: "u", ...modifier });
  expect(screen.getByRole("dialog", { name: "附加远程文件" })).toBeTruthy();
});

it("mentions @ references in the session placeholder", () => {
  render(<Composer busy={false} sessionId="s6" draftKey="p" onSend={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }).placeholder).toBe(
    COMPOSER_PLACEHOLDER,
  );
  expect(COMPOSER_PLACEHOLDER).toContain("@ 引用文件");
});

it("waits for the listing before showing an empty state", async () => {
  const { client } = fakeClient();
  const { input } = renderCard({ client, sessionId: "s7" });
  fireEvent.change(input, { target: { value: "@zzzz" } });
  await waitFor(() => expect(screen.getByText("没有匹配的文件")).toBeTruthy());
});
