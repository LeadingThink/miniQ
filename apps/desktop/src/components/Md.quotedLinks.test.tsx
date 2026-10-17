// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Md } from "./Md";

afterEach(cleanup);

it.each([false, true])("opens a quoted file using the real file handler (streaming=%s)", (streaming) => {
  const onOpenFile = vi.fn();
  render(<Md workspacePath="/w" streaming={streaming} onOpenFile={onOpenFile}>
    {'### 商业计划书\n\n- `[商业计划书.pptx](/w/资料库/商业计划书.pptx)`\n- ``[预览 PDF](</w/计划 书.pdf>)``'}
  </Md>);
  fireEvent.click(screen.getByRole("link", { name: "商业计划书.pptx" }));
  expect(onOpenFile).toHaveBeenLastCalledWith({ path: "/w/资料库/商业计划书.pptx", line: null, column: null });
  fireEvent.click(screen.getByRole("link", { name: "预览 PDF" }));
  expect(onOpenFile).toHaveBeenLastCalledWith({ path: "/w/计划 书.pdf", line: null, column: null });
});
