// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DeepThinking } from "./DeepThinking";

afterEach(cleanup);

it("streams in an expanded panel and preserves a manual collapse as tokens arrive", () => {
  const { rerender } = render(<DeepThinking text="检查" streaming />);
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("region").textContent).toBe("检查");
  fireEvent.click(screen.getByRole("button"));
  rerender(<DeepThinking text="检查两个方案" streaming />);
  expect(screen.queryByRole("region")).toBeNull();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("region").textContent).toBe("检查两个方案");
  rerender(<DeepThinking text="检查两个方案" />);
  expect(screen.queryByText("思考中…")).toBeNull();
});

it("keeps complete history available behind a collapsed panel without truncation", () => {
  const text = "较长的思考摘要\n".repeat(1500) + "最后一行";
  render(<DeepThinking text={text} />);
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("region").textContent).toBe(text);
});

it("renders no module when the provider returns no thinking", () => {
  const { container } = render(<DeepThinking streaming />);
  expect(container.childElementCount).toBe(0);
});
