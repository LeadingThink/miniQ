// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MermaidPreview, svgDataUrl } from "./MermaidPreview";

const mocks = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mocks }));

beforeEach(() => {
  mocks.render.mockReset();
});
afterEach(cleanup);

it("renders Unicode diagrams as portable data images and retains their complete source", async () => {
  mocks.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>流程 #1</text></svg>',
  });
  const view = render(<MermaidPreview source="graph LR; A-->B" />);
  const sourceUrl = (await screen.findByRole("img")).getAttribute("src") ?? "";
  expect(sourceUrl).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  expect(decodeURIComponent(sourceUrl.split(",", 2)[1])).toContain("流程 #1");
  expect(mocks.initialize).toHaveBeenCalledWith(
    expect.objectContaining({ securityLevel: "strict", startOnLoad: false }),
  );
  expect(view.container.querySelector("code")?.textContent).toBe(
    "graph LR; A-->B",
  );
  expect(view.container.querySelector("svg text")).toBeNull();
});

it("encodes SVG markup that would otherwise change data URL semantics", () => {
  const url = svgDataUrl('<svg><text fill="#14775f">A &amp; B</text></svg>');
  expect(url).not.toContain("#14775f");
  expect(decodeURIComponent(url.split(",", 2)[1])).toBe(
    '<svg><text fill="#14775f">A &amp; B</text></svg>',
  );
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

it("does not publish a diagram that finishes after unmount", async () => {
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
  expect(screen.queryByRole("img")).toBeNull();
});
