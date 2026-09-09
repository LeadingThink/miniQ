// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SvgPreview } from "./SvgPreview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("uses detached SVG dimensions for original-size zoom and discards late measurements", () => {
  const probes: Array<{
    naturalWidth: number;
    naturalHeight: number;
    src: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
  }> = [];
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 900;
      naturalHeight = 450;
      src = "";
      onload = null;
      onerror = null;
      constructor() {
        probes.push(this);
      }
    },
  );
  const create = vi
    .fn()
    .mockReturnValueOnce("blob:first")
    .mockReturnValueOnce("blob:second");
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  const view = render(
    <SvgPreview content="<svg/>" label="chart" onError={vi.fn()} />,
  );
  act(() => probes[0].onload?.());
  const image = screen.getByRole("img");
  Object.defineProperties(image, {
    naturalWidth: { value: 300 },
    naturalHeight: { value: 150 },
  });
  fireEvent.load(image);
  expect(screen.getByText("900 × 450 px")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "图片原始尺寸" }));
  expect((image as HTMLImageElement).style.width).toBe("900px");
  view.rerender(
    <SvgPreview content="<svg width='800'/>" label="next" onError={vi.fn()} />,
  );
  expect(probes[0].onload).toBeNull();
  expect(revoke).toHaveBeenCalledWith("blob:first");
  expect(screen.queryByRole("img")).toBeNull();
  view.unmount();
  expect(probes[1].onload).toBeNull();
  expect(revoke).toHaveBeenCalledWith("blob:second");
});
