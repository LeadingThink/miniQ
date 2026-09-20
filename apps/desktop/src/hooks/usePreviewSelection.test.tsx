// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { usePreviewSelection } from "./usePreviewSelection";

afterEach(cleanup);
function Fixture({ path = "a" }: { path?: string }) {
  const selection = usePreviewSelection(path);
  return (
    <>
      <div ref={selection.ref}>
        <p>完整的选中内容</p>
      </div>
      <p>另一个面板</p>
      <output aria-label="选区">{selection.text}</output>
      <button onClick={selection.clear}>清除</button>
    </>
  );
}
function select(element: Element) {
  act(() => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}
it("captures only this preview, retains text across focus, and clears on file switch", () => {
  const { rerender } = render(<Fixture />);
  select(screen.getByText("完整的选中内容"));
  expect(screen.getByLabelText("选区").textContent).toBe("完整的选中内容");
  act(() => {
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(screen.getByLabelText("选区").textContent).toBe("完整的选中内容");
  select(screen.getByText("另一个面板"));
  expect(screen.getByLabelText("选区").textContent).toBe("");
  select(screen.getByText("完整的选中内容"));
  rerender(<Fixture path="b" />);
  expect(screen.getByLabelText("选区").textContent).toBe("");
  select(screen.getByText("完整的选中内容"));
  fireEvent.click(screen.getByText("清除"));
  expect(screen.getByLabelText("选区").textContent).toBe("");
});
