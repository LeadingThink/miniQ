// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDiff } from "../types";
import { ReviewPanel } from "./ReviewPanel";
import { PreviewViewStore } from "../previewViewState";

afterEach(cleanup);

const DIFF: SessionDiff = {
  additions: 1,
  deletions: 1,
  files: [
    {
      path: "src/main.ts",
      absolutePath: "D:/work/app/src/main.ts",
      oldExists: true,
      newExists: true,
      binary: false,
      additions: 1,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: "deletion", oldLine: 1, newLine: null, content: "old" },
            { kind: "addition", oldLine: null, newLine: 1, content: "new" },
          ],
        },
      ],
    },
  ],
};

describe("ReviewPanel", () => {
  it("renders changed files, stats, line numbers, and diff content", () => {
    const html = renderToStaticMarkup(
      <ReviewPanel
        diff={DIFF}
        onOpenFile={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("src/main.ts");
    expect(html).toContain("+1");
    expect(html).toContain("-1");
    expect(html).toContain("old");
    expect(html).toContain("new");
  });

  it("filters file paths and navigates within matching files without losing the selected file", () => {
    const files = [
      DIFF.files[0],
      {
        ...DIFF.files[0],
        path: "src/helper.ts",
        absolutePath: "D:/work/app/src/helper.ts",
      },
      {
        ...DIFF.files[0],
        path: "README.md",
        absolutePath: "D:/work/app/README.md",
      },
    ];
    render(
      <ReviewPanel
        diff={{ ...DIFF, files }}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const list = screen.getByRole("navigation", { name: "已修改文件" });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "SRC/" },
    });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(
      (screen.getByRole("button", { name: "上一个文件" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "下一个文件" }));
    expect(
      screen.getByRole("button", { name: "打开 src/helper.ts" }),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "下一个文件" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "清除文件筛选" }));
    expect(within(list).getAllByRole("button")).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "打开 src/helper.ts" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "not-found" },
    });
    expect(
      screen.getByText("没有匹配的文件，试试其他路径或清除筛选。"),
    ).toBeTruthy();
  });

  it("shows useful empty and retry states, and does not mislabel a failed load as no changes", () => {
    const retry = vi.fn();
    const empty = { additions: 0, deletions: 0, files: [] };
    const view = render(
      <ReviewPanel diff={empty} onOpenFile={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText(/暂无文件改动/)).toBeTruthy();
    view.rerender(
      <ReviewPanel
        diff={empty}
        error="读取审阅失败"
        onRetry={retry}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("读取审阅失败");
    expect(screen.queryByText(/暂无文件改动/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps reviewed marks while browsing, resets them for a refreshed diff, and locates file lines", () => {
    const open = vi.fn();
    const view = render(
      <ReviewPanel diff={DIFF} onOpenFile={open} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "标记为已审阅" }));
    expect(
      screen
        .getByRole("button", { name: "标记为未审阅" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "打开 src/main.ts" }));
    expect(open).toHaveBeenCalledWith({
      path: "D:/work/app/src/main.ts",
      line: 1,
      column: null,
    });
    view.rerender(
      <ReviewPanel
        diff={{
          ...DIFF,
          files: DIFF.files.map((file) => ({ ...file, additions: 2 })),
        }}
        onOpenFile={open}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "标记为已审阅" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("incrementally renders all lines even when a single hunk exceeds a batch", () => {
    const lines = Array.from({ length: 625 }, (_, index) => ({
      kind: "addition" as const,
      oldLine: null,
      newLine: index + 1,
      content: `line-${index + 1}`,
    }));
    const diff = {
      ...DIFF,
      files: [
        { ...DIFF.files[0], hunks: [{ ...DIFF.files[0].hunks[0], lines }] },
      ],
    };
    const view = render(
      <ReviewPanel diff={diff} onOpenFile={vi.fn()} onClose={vi.fn()} />,
    );
    expect(view.container.querySelectorAll(".diff-line")).toHaveLength(300);
    expect(screen.queryByText("line-625")).toBeNull();
    const paging = within(
      view.container.querySelector<HTMLElement>(".review-load-more")!,
    );
    fireEvent.click(
      paging.getByRole("button", { name: "继续加载差异（300 行）" }),
    );
    expect(view.container.querySelectorAll(".diff-line")).toHaveLength(600);
    fireEvent.click(
      paging.getByRole("button", { name: "继续加载差异（25 行）" }),
    );
    expect(view.container.querySelectorAll(".diff-line")).toHaveLength(625);
    expect(screen.getByText("line-625")).toBeTruthy();
    expect(paging.queryByRole("button", { name: /继续加载差异/ })).toBeNull();
  });

  it("restores filter, selection and review marks across panel unmounts while isolating sessions", () => {
    const store = new PreviewViewStore();
    const files = [
      DIFF.files[0],
      {
        ...DIFF.files[0],
        path: "src/helper.ts",
        absolutePath: "D:/work/app/src/helper.ts",
      },
    ];
    const props = {
      diff: { ...DIFF, files },
      onOpenFile: vi.fn(),
      onClose: vi.fn(),
      viewStore: store,
      viewScope: "session-a",
    };
    const first = render(<ReviewPanel {...props} />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "helper" },
    });
    fireEvent.click(screen.getByRole("button", { name: "标记为已审阅" }));
    first.unmount();
    const second = render(
      <ReviewPanel
        {...props}
        diff={{ ...DIFF, files: files.map((file) => ({ ...file })) }}
      />,
    );
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(
      "helper",
    );
    expect(
      screen.getByRole("button", { name: "打开 src/helper.ts" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "标记为未审阅" })).toBeTruthy();
    second.rerender(<ReviewPanel {...props} viewScope="session-b" />);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(
      screen.getByRole("button", { name: "打开 src/main.ts" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "标记为已审阅" })).toBeTruthy();
  });

  it("clears a reviewed marker when text changes even with unchanged line counts", () => {
    const props = { diff: DIFF, onOpenFile: vi.fn(), onClose: vi.fn() };
    const view = render(<ReviewPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "标记为已审阅" }));
    const file = DIFF.files[0];
    view.rerender(
      <ReviewPanel
        {...props}
        diff={{
          ...DIFF,
          files: [
            {
              ...file,
              hunks: file.hunks.map((hunk) => ({
                ...hunk,
                lines: hunk.lines.map((line) => ({
                  ...line,
                  content: `${line.content} changed`,
                })),
              })),
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "标记为已审阅" })).toBeTruthy();
  });
});
