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
      <output aria-label="选区锚点">
        {selection.anchor ? `${selection.anchor.x},${selection.anchor.y}` : ""}
      </output>
      <output aria-label="选区行号">{selection.startLine}–{selection.endLine}</output>
      <button onClick={() => selection.setText({
        text: "编辑器选区",
        startLine: 55,
        endLine: 62,
      }, { x: 360, y: 240 })}>
        编辑器选中
      </button>
      <button onClick={selection.clear}>清除</button>
    </>
  );
}
function select(element: Element) {
  act(() => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.getBoundingClientRect = () =>
      ({ left: 120, top: 80, right: 200, bottom: 104 }) as DOMRect;
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}
it("captures only this preview, retains text across focus, and clears on file switch", () => {
  const { rerender } = render(<Fixture />);
  select(screen.getByText("完整的选中内容"));
  expect(screen.getByLabelText("选区").textContent).toBe("完整的选中内容");
  expect(screen.getByLabelText("选区锚点").textContent).toBe("120,80");
  expect(screen.getByLabelText("选区行号").textContent).toBe("1–1");
  act(() => {
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(screen.getByLabelText("选区").textContent).toBe("完整的选中内容");
  select(screen.getByText("另一个面板"));
  expect(screen.getByLabelText("选区").textContent).toBe("");
  expect(screen.getByLabelText("选区锚点").textContent).toBe("");
  select(screen.getByText("完整的选中内容"));
  rerender(<Fixture path="b" />);
  expect(screen.getByLabelText("选区").textContent).toBe("");
  select(screen.getByText("完整的选中内容"));
  fireEvent.click(screen.getByText("清除"));
  expect(screen.getByLabelText("选区").textContent).toBe("");
});

it("accepts an explicit viewport anchor from a code editor selection", () => {
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "编辑器选中" }));
  expect(screen.getByLabelText("选区").textContent).toBe("编辑器选区");
  expect(screen.getByLabelText("选区锚点").textContent).toBe("360,240");
  expect(screen.getByLabelText("选区行号").textContent).toBe("55–62");
});
