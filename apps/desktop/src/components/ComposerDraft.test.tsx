// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerCard } from "./Composer";
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("appends a preview file reference to the current draft without sending it", () => {
  const onSend = vi.fn(async () => true);
  const applied = vi.fn();
  const props = {
    busy: false,
    placeholder: "消息",
    draftKey: "preview-followup",
    onSend,
  };
  const view = render(<ComposerCard {...props} />);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "请保留已经完成的部分" },
  });
  view.rerender(
    <ComposerCard
      {...props}
      draftRequest={{
        id: 1,
        content: "关于文件「/work/report.pdf」：\n",
        append: true,
      }}
      onDraftRequestApplied={applied}
    />,
  );
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(
    "请保留已经完成的部分\n\n关于文件「/work/report.pdf」：\n",
  );
  expect(onSend).not.toHaveBeenCalled();
  expect(applied).toHaveBeenCalledTimes(1);
  view.rerender(<ComposerCard {...props} />);
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox").value.match(/关于文件/g),
  ).toHaveLength(1);
});

it("keeps multiple file selections as removable references and expands them on send", async () => {
  const onSend = vi.fn(async () => true);
  const props = {
    busy: false,
    placeholder: "消息",
    draftKey: "multi-file-selection",
    onSend,
  };
  const view = render(<ComposerCard {...props} draftRequest={{
    id: 1,
    append: true,
    context: {
      kind: "file-selection" as const,
      label: "a.ts 第 5–11 行",
      text: "文件「/work/a.ts」第 5–11 行：\n> const a = 1;",
    },
  }} />);
  expect(screen.getByText("a.ts 第 5–11 行")).toBeTruthy();

  view.rerender(<ComposerCard {...props} draftRequest={{
    id: 2,
    append: true,
    context: {
      kind: "file-selection" as const,
      label: "b.rs 第 20 行",
      text: "文件「/work/b.rs」第 20 行：\n> let b = 2;",
    },
  }} />);
  expect(screen.getByText("a.ts 第 5–11 行")).toBeTruthy();
  expect(screen.getByText("b.rs 第 20 行")).toBeTruthy();
  const field = screen.getByText("a.ts 第 5–11 行").closest(".composer-field");
  expect(Array.from(field?.children ?? []).map((element) => element.className)).toEqual([
    "paste-chip",
    "paste-chip",
    "composer-segment",
  ]);

  fireEvent.click(screen.getByRole("button", { name: "移除a.ts 第 5–11 行" }));
  expect(screen.queryByText("a.ts 第 5–11 行")).toBeNull();
  expect(screen.getByText("b.rs 第 20 行")).toBeTruthy();
  fireEvent.change(screen.getAllByRole("textbox").at(-1)!, { target: { value: "请解释" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

  expect(onSend).toHaveBeenCalledWith(
    "文件「/work/b.rs」第 20 行：\n> let b = 2;\n\n请解释",
    [],
  );
});
