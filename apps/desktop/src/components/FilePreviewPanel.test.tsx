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

it("retries reading after a read failure without exposing the transfer route", () => {
  const retry = vi.fn();
  render(<FilePreviewPanel
    preview={{ target: { path: "/project/file.pdf", line: null, column: null },
      resolvedPath: "/project/file.pdf", content: null, kind: null, mimeType: null,
      dataBase64: null, size: null, loading: false, open: true,
      error: "文件存储暂不可用", transport: "connection" }}
    workspacePath="/project" workspacePaths={[]} onClose={vi.fn()}
    onOpenFile={vi.fn()} onRetry={retry}
  />);
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(screen.queryByText(/传输方式/)).toBeNull();
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

it("offers mobile authorization only for a session permission refusal", () => {
  const target = { path: "/outside/report.txt", line: null, column: null };
  const authorize = vi.fn();
  render(<FilePreviewPanel
    preview={{ target, resolvedPath: target.path, content: null, kind: null, mimeType: null,
      dataBase64: null, size: null, loading: false, open: true,
      error: "没有权限读取此文件，请检查当前会话的文件授权", canAuthorize: true }}
    workspacePath="/project" workspacePaths={[]} onClose={vi.fn()}
    onOpenFile={vi.fn()} onRetry={vi.fn()} onAuthorizeFile={authorize}
  />);
  fireEvent.click(screen.getByRole("button", { name: "允许并打开" }));
  expect(authorize).toHaveBeenCalledWith(target, false);
});

it("shows the canonical file and session scope before mobile confirmation, and can refuse", () => {
  const target = { path: "/outside/link.txt", line: null, column: null };
  const confirm = vi.fn();
  const cancel = vi.fn();
  render(<FilePreviewPanel
    preview={{ target, resolvedPath: target.path, content: null, kind: null, mimeType: null,
      dataBase64: null, size: null, loading: false, open: true, error: "需要文件授权",
      authorization: { path: "/outside/canonical.txt", confirm, cancel } }}
    workspacePath="/project" workspacePaths={[]} onClose={vi.fn()}
    onOpenFile={vi.fn()} onRetry={vi.fn()} onAuthorizeFile={vi.fn()}
  />);
  expect(screen.getByText("/outside/canonical.txt")).toBeTruthy();
  expect(screen.getByText(/仅允许当前会话读取此文件/)).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消授权" }));
  expect(cancel).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
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

  expect(screen.getByRole("alert").textContent).toContain("未找到文件：D:/study/readme");
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

it("does not claim to convert legacy WPS files in a remote WebView", () => {
  render(
    <FilePreviewPanel
      preview={{
        target: { path: "/workspace/draft.wps", line: null, column: null },
        resolvedPath: "/workspace/draft.wps",
        content: null,
        kind: "officeLegacy",
        mimeType: "application/vnd.miniq.office-legacy",
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
    />,
  );

  expect(screen.getByText("暂不支持内嵌预览此格式")).toBeTruthy();
  expect(screen.getByText(/下载到当前设备查看/)).toBeTruthy();
});

it("shows a file-type icon and clickable breadcrumb folders", () => {
  const target = { path: "/w/proj/docs/notes.txt", line: null, column: null };
  const reveal = vi.fn();
  const { container } = render(
    <FilePreviewPanel
      preview={{
        target,
        resolvedPath: target.path,
        content: "hello",
        kind: "text",
        mimeType: null,
        dataBase64: null,
        size: 5,
        loading: false,
        error: null,
        open: true,
      }}
      workspacePath="/w/proj"
      workspacePaths={[]}
      onClose={vi.fn()}
      onOpenFile={vi.fn()}
      onRetry={vi.fn()}
      onRevealDirectory={reveal}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "文件位置" });
  expect(nav.textContent).toBe("projdocsnotes.txt");
  fireEvent.click(screen.getByRole("button", { name: "docs" }));
  expect(reveal).toHaveBeenCalledWith("/w/proj/docs");
  fireEvent.click(screen.getByRole("button", { name: "proj" }));
  expect(reveal).toHaveBeenLastCalledWith("/w/proj");
  expect(container.querySelector(".file-preview-header .file-kind-icon")).not.toBeNull();
});

it("offers explicit continuation and shows partial HTML as source", async () => {
  const loadNextPage = vi.fn();
  render(<FilePreviewPanel preview={{ target: { path: "/workspace/large.html", line: null, column: null }, resolvedPath: "/workspace/large.html", content: "<h1>partial</h1>", kind: "text", mimeType: "text/html", dataBase64: null, size: 500000, loading: false, error: null, open: true, textPage: { end: 262144, total: 500000, next: vi.fn() }, loadNextPage }} workspacePath="/workspace" workspacePaths={[]} onClose={vi.fn()} onOpenFile={vi.fn()} onRetry={vi.fn()} />);
  expect(await screen.findByLabelText("代码视图")).toBeTruthy();
  expect(document.querySelector("iframe")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "继续读取下一段" }));
  expect(loadNextPage).toHaveBeenCalledOnce();
});
