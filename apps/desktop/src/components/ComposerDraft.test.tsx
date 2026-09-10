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
