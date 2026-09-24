// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FilePreviewPanel } from "./FilePreviewPanel";
const loadEditor = vi.hoisted(() => vi.fn());
vi.mock("./CodePreview", () => {
  loadEditor();
  return {
    default: ({ content }: { content: string }) => (
      <pre aria-label="代码视图">{content}</pre>
    ),
  };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

it("offers explicit authorization for a file outside the workspace", () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  const target = { path: "D:/outside/report.jsonl", line: null, column: null };
  const authorize = vi.fn();
  render(
    <FilePreviewPanel
      preview={{
        target,
        resolvedPath: target.path,
        content: null,
        kind: null,
        mimeType: null,
        dataBase64: null,
        size: null,
        loading: false,
        error: "拒绝打开工作区外的文件: D:/outside/report.jsonl",
        open: true,
      }}
      workspacePath="D:/workspace"
      workspacePaths={[]}
      onClose={vi.fn()}
      onOpenFile={vi.fn()}
      onRetry={vi.fn()}
      onAuthorizeFile={authorize}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "允许并打开" }));
  expect(authorize).toHaveBeenCalledWith(target, false);
});

it("offers file selection when a resolved reference does not exist", () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  const target = { path: "D:/study/readme", line: null, column: null };
  const authorize = vi.fn();
  render(
    <FilePreviewPanel
      preview={{
        target,
        resolvedPath: target.path,
        content: null,
        kind: null,
        mimeType: null,
        dataBase64: null,
        size: null,
        loading: false,
        error: "无法访问文件 D:/study/readme: 系统找不到指定的文件。 (os error 2)",
        open: true,
      }}
      workspacePath="D:/study"
      workspacePaths={[]}
      onClose={vi.fn()}
      onOpenFile={vi.fn()}
      onRetry={vi.fn()}
      onAuthorizeFile={authorize}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "选择并打开" }));
  expect(authorize).toHaveBeenCalledWith(target, true);
});

it("does not load the code editor for Markdown rendering, but loads it on demand", async () => {
  render(
    <FilePreviewPanel
      preview={{
        target: { path: "/workspace/report.md", line: null, column: null },
        resolvedPath: "/workspace/report.md",
        content: "# Evidence\n\nComplete report.",
        kind: "markdown",
        mimeType: "text/markdown",
        dataBase64: null,
        size: 40,
        loading: false,
        error: null,
        open: true,
      }}
      workspacePath="/workspace"
      workspacePaths={[]}
      onClose={() => {}}
      onOpenFile={() => {}}
      onRetry={() => {}}
    />,
  );
  expect(screen.getByRole("heading", { name: "Evidence" })).toBeTruthy();
  expect(loadEditor).not.toHaveBeenCalled();
  const article = screen.getByLabelText("Markdown 预览");
  fireEvent.click(screen.getByRole("button", { name: "展开预览" }));
  expect(screen.getByLabelText("Markdown 预览")).toBe(article);
  expect(viewportExpanded()).toBe(true);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "恢复分栏预览" }),
  );
  fireEvent.keyDown(document.activeElement!, {
    key: "Escape",
  });
  expect(viewportExpanded()).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
  expect((await screen.findByLabelText("代码视图")).textContent).toContain(
    "# Evidence",
  );
  expect(loadEditor).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "渲染预览" }));
  expect(screen.getByRole("heading", { name: "Evidence" })).toBeTruthy();
});

function viewportExpanded() {
  return screen
    .getByRole("complementary", { name: "文件预览" })
    .classList.contains("preview-expanded");
}

it("offers mobile download and follow-up without desktop-only actions", () => {
  const discuss = vi.fn();
  render(
    <FilePreviewPanel
      preview={{
        target: { path: "/workspace/output.zip", line: null, column: null },
        resolvedPath: "/workspace/output.zip",
        content: null,
        kind: "unsupported",
        mimeType: "application/zip",
        dataBase64: null,
        size: 40,
        loading: false,
        error: null,
        open: true,
      }}
      workspacePath="/workspace"
      workspacePaths={[]}
      onClose={vi.fn()}
      onOpenFile={vi.fn()}
      onRetry={vi.fn()}
      onDiscuss={discuss}
    />,
  );
  expect(screen.getByRole("button", { name: "下载到当前设备" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "在文件夹中显示" })).toBeNull();
  expect(screen.queryByRole("button", { name: "在外部编辑器中打开" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "使用系统默认应用打开" }),
  ).toBeNull();
  const location = document.querySelector<HTMLDetailsElement>(".file-preview-path")!;
  expect(location.open).toBe(false);
  fireEvent.click(location.querySelector("summary")!);
  expect(location.open).toBe(true);
  expect(location.querySelector(":scope > span")?.textContent).toBe("/workspace/output.zip");
  fireEvent.click(screen.getByRole("button", { name: "针对这个文件继续提问" }));
  expect(discuss).toHaveBeenCalledWith("/workspace/output.zip");
});
