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
afterEach(cleanup);

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
