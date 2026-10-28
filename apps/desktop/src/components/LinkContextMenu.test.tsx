// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Md } from "./Md";
import { ArtifactCard } from "./TimelineInteractions";
import { SessionFileAccess } from "../sessionFileAccess";
import { ToastProvider } from "./ui/Toast";

const { invoke, openUrl } = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: (command: string, args: unknown) => invoke(command, args) };
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  invoke.mockImplementation(async (command: string) => {
    if (command === "file_open_applications") return [
      { id: "preview", name: "Preview", isDefault: true },
      { id: "other", name: "另一个应用", isDefault: false },
    ];
    if (command === "read_local_text_file") return { path: "/w/资料/说明.md", content: "完整文件内容" };
    return null;
  });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); invoke.mockReset(); openUrl.mockReset();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function conversation(markdown: string, onOpenFile = vi.fn(), mode: "local" | "remote" = "local") {
  return render(<ToastProvider><SessionFileAccess client={{ mode, call: vi.fn() } as never} sessionId="s1"
    workspacePath="/w" workspacePaths={["/attached"]} authorizedFiles={["/else/report.pdf"]}>
    <Md workspacePath="/w" onOpenFile={onOpenFile} onOpenUrl={vi.fn()}>{markdown}</Md>
  </SessionFileAccess></ToastProvider>);
}

it("replaces the WebView menu and preserves the decoded file target and location", async () => {
  const onOpen = vi.fn();
  conversation("[报告 (line 17)](</w/资料/报告%20一.pdf>)", onOpen);
  const link = screen.getByRole("link", { name: "报告 (line 17)" });
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
  fireEvent(link, event);
  expect(event.defaultPrevented).toBe(true);
  await screen.findByRole("menuitem", { name: "在 Preview 中打开" });
  expect(screen.queryByRole("menuitem", { name: "复制文件内容" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "打开文件" }));
  expect(onOpen).toHaveBeenCalledWith({ path: "/w/资料/报告 一.pdf", line: 17, column: null });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(link);
});

it("copies the real path and routes save/reveal through the session authorization", async () => {
  conversation("[报告](/else/report.pdf)");
  const open = () => fireEvent.contextMenu(screen.getByRole("link", { name: "报告" }));
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "复制路径" }));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/else/report.pdf");
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "另存为…" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_local_file_as", {
    path: "/else/report.pdf", workspacePath: "/w", workspacePaths: ["/attached"], authorizedFiles: ["/else/report.pdf"],
  }));
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "在 Finder 中显示" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("reveal_local_file", expect.objectContaining({ authorizedFiles: ["/else/report.pdf"] })));
});

it("opens a real application submenu with keyboard and keeps it open during interaction", async () => {
  conversation("[报告](/w/a.pdf)");
  const link = screen.getByRole("link");
  fireEvent.keyDown(link, { key: "F10", shiftKey: true });
  const trigger = await screen.findByRole("menuitem", { name: "打开方式" });
  fireEvent.keyDown(trigger, { key: "ArrowRight" });
  const submenu = screen.getByRole("menu", { name: "打开方式" });
  const application = within(submenu).getByRole("menuitem", { name: "另一个应用" });
  fireEvent.mouseDown(application);
  expect(screen.getByRole("menu", { name: "文件操作" })).toBeTruthy();
  fireEvent.click(application);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_local_file_with", expect.objectContaining({ path: "/w/a.pdf", applicationId: "other" })));
  expect(screen.queryByRole("menu")).toBeNull();
});

it("supports explicitly relative inline file references and copies complete text", async () => {
  conversation("`./资料/说明.md`");
  fireEvent.keyDown(screen.getByRole("button", { name: "./资料/说明.md" }), { key: "ContextMenu" });
  fireEvent.click(screen.getByRole("menuitem", { name: "复制文件内容" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("完整文件内容"));
});

it("provides URL actions without local file actions", async () => {
  conversation("[网站](https://example.com/page?q=1)");
  const link = screen.getByRole("link");
  fireEvent.contextMenu(link);
  expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["新标签页", "新窗口", "默认浏览器", "复制链接", "链接另存为…"]);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "复制链接" }));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://example.com/page?q=1");
  fireEvent.contextMenu(link);
  fireEvent.click(screen.getByRole("menuitem", { name: "链接另存为…" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_external_link_as", { url: "https://example.com/page?q=1" }));
});

it("does not intercept ordinary text, heading anchors or input menus", () => {
  conversation("普通文本\n\n[跳转](#heading)");
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  fireEvent(screen.getByText("普通文本"), event);
  expect(event.defaultPrevented).toBe(false);
  fireEvent.contextMenu(screen.getByRole("link"));
  expect(screen.queryByRole("menu")).toBeNull();
});

it("hides local operations for remote files and has a download action", () => {
  conversation("[报告](/w/a.pdf)", vi.fn(), "remote");
  fireEvent.contextMenu(screen.getByRole("link"));
  expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["打开文件", "下载到当前设备", "复制路径"]);
  expect(invoke).not.toHaveBeenCalled();
});

it("uses the same context menu on artifact cards", async () => {
  render(<ArtifactCard artifact={{ id: "a", sessionId: "s", path: "/w/a.pdf", title: "a.pdf", kind: "pdf", createdAt: "" }}
    workspacePath="/w" onOpenFile={vi.fn()} onError={vi.fn()} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "打开 a.pdf" }));
  await screen.findByRole("menuitem", { name: "在 Preview 中打开" });
});

it("restores focus after Escape and does not reuse a menu after switching sessions", () => {
  const view = conversation("[报告](/w/a.pdf)");
  const link = screen.getByRole("link");
  fireEvent.contextMenu(link);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(document.activeElement).toBe(link);
  fireEvent.contextMenu(link);
  act(() => view.rerender(<Md workspacePath="/different">{"[报告](/different/b.pdf)"}</Md>));
  expect(screen.queryByRole("menu")).toBeNull();
});
