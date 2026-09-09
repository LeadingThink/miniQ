// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DelimitedPreview } from "./DelimitedPreview";
const instances = vi.hoisted(
  () =>
    [] as Array<{
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      onmessage: (event: unknown) => void;
      onerror: () => void;
    }>,
);
vi.mock("../delimitedPreview.worker?worker", () => ({
  default: class {
    postMessage = vi.fn();
    terminate = vi.fn();
    onmessage = () => {};
    onerror = () => {};
    constructor() {
      instances.push(this);
    }
  },
}));
beforeEach(() => {
  instances.length = 0;
});
afterEach(cleanup);
it("parses off-thread, preserves data and terminates the worker on file changes", async () => {
  const view = render(
    <DelimitedPreview
      content={"001\t002"}
      path="/test.tsv"
      onError={vi.fn()}
    />,
  );
  expect(instances[0].postMessage).toHaveBeenCalledWith({
    content: "001\t002",
    delimiter: "\t",
  });
  act(() => instances[0].onmessage({ data: { rows: [["001", "002"]] } }));
  await screen.findByRole("cell", { name: "001" });
  expect(instances[0].terminate).toHaveBeenCalled();
  view.rerender(
    <DelimitedPreview content="a,b" path="/other.csv" onError={vi.fn()} />,
  );
  expect(instances).toHaveLength(2);
  expect(instances[1].postMessage).toHaveBeenCalledWith({
    content: "a,b",
    delimiter: ",",
  });
  act(() => instances[0].onmessage({ data: { rows: [["obsolete"]] } }));
  expect(screen.queryByRole("cell", { name: "obsolete" })).toBeNull();
  view.unmount();
  expect(instances[1].terminate).toHaveBeenCalled();
});
it("surfaces parse failures and uses the current callback without reparsing", async () => {
  const first = vi.fn();
  const next = vi.fn();
  const view = render(
    <DelimitedPreview content="bad" path="/test.csv" onError={first} />,
  );
  view.rerender(
    <DelimitedPreview content="bad" path="/test.csv" onError={next} />,
  );
  act(() => instances[0].onmessage({ data: { error: "invalid quotes" } }));
  await waitFor(() => expect(next).toHaveBeenCalledWith("invalid quotes"));
  expect(first).not.toHaveBeenCalled();
  expect(instances).toHaveLength(1);
  expect(screen.queryByText("正在解析表格...")).toBeNull();
});
