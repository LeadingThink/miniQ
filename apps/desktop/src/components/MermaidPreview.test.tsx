// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MermaidPreview } from "./MermaidPreview";
const mocks = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mocks }));
beforeEach(() => {
  mocks.render.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:diagram");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);
it("renders diagrams in a non-executable image context and retains their complete source", async () => {
  mocks.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>graph</text></svg>',
  });
  const view = render(<MermaidPreview source="graph LR; A-->B" />);
  expect((await screen.findByRole("img")).getAttribute("src")).toBe(
    "blob:diagram",
  );
  expect(mocks.initialize).toHaveBeenCalledWith(
    expect.objectContaining({ securityLevel: "strict", startOnLoad: false }),
  );
  expect(view.container.querySelector("code")?.textContent).toBe(
    "graph LR; A-->B",
  );
  expect(view.container.querySelector("svg text")).toBeNull();
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:diagram");
});
it("shows malformed diagram errors with source, not a blank preview", async () => {
  mocks.render.mockRejectedValue(new Error("syntax error"));
  const view = render(<MermaidPreview source="bad graph" />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "syntax error",
  );
  expect(view.container.querySelector("details")?.open).toBe(true);
  expect(view.container.querySelector("code")?.textContent).toBe("bad graph");
});
it("does not create URLs for a diagram that finishes after unmount", async () => {
  let finish!: (value: { svg: string }) => void;
  mocks.render.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<MermaidPreview source="graph LR; A-->B" />);
  await waitFor(() => expect(mocks.render).toHaveBeenCalled());
  view.unmount();
  await act(async () => finish({ svg: "<svg/>" }));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
