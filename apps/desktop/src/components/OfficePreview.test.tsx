// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocxPreview, PptxPreview } from "./OfficePreview";

const mocks = vi.hoisted(() => ({ render: vi.fn(), init: vi.fn() }));
vi.mock("docx-preview", () => ({ renderAsync: mocks.render }));
vi.mock("pptx-preview", () => ({ init: mocks.init }));
beforeEach(() => {
  mocks.render.mockReset();
  mocks.init.mockReset();
});
afterEach(cleanup);

it("fits real page widths and updates zoom and page navigation without reparsing", async () => {
  let width = 500;
  const observers: Array<() => void> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const measured = vi
    .spyOn(HTMLElement.prototype, "clientWidth", "get")
    .mockImplementation(() => width);
  const natural = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockReturnValue(1000);
  mocks.render.mockImplementation(async (_bytes, target: HTMLElement) => {
    for (let index = 0; index < 3; index++) {
      const page = document.createElement("section");
      page.className = "docx";
      page.getBoundingClientRect = () => ({ top: index * 1000 }) as DOMRect;
      target.append(page);
    }
  });
  const view = render(<DocxPreview dataBase64="AA==" onError={vi.fn()} />);
  await waitFor(() =>
    expect(
      view.container.querySelector<HTMLElement>(".office-document")?.style.zoom,
    ).toBe("0.5"),
  );
  width = 300;
  act(() => observers.forEach((callback) => callback()));
  expect(
    view.container.querySelector<HTMLElement>(".office-document")?.style.zoom,
  ).toBe("0.3");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(view.container.querySelector(".office-preview")?.scrollTop).toBe(1000);
  expect((screen.getByLabelText("Word 页码") as HTMLInputElement).value).toBe(
    "2",
  );
  fireEvent.click(screen.getByRole("button", { name: "重置 Word 缩放" }));
  expect(
    view.container.querySelector<HTMLElement>(".office-document")?.style.zoom,
  ).toBe("1");
  expect(mocks.render).toHaveBeenCalledTimes(1);
  measured.mockRestore();
  natural.mockRestore();
  vi.unstubAllGlobals();
});

it("keeps the last page active at the bottom even when a taller previous page is more visible", async () => {
  mocks.render.mockImplementation(async (_bytes, target: HTMLElement) => {
    for (const [top, bottom] of [
      [-200, 350],
      [350, 500],
    ]) {
      const page = document.createElement("section");
      page.className = "docx";
      page.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
      target.append(page);
    }
  });
  const view = render(<DocxPreview dataBase64="AA==" onError={vi.fn()} />);
  await screen.findByRole("region", { name: "第 2 页" });
  const stage = view.container.querySelector<HTMLElement>(".office-preview")!;
  stage.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
  Object.defineProperties(stage, {
    clientHeight: { value: 500 },
    scrollHeight: { value: 1000 },
  });
  stage.scrollTop = 300;
  fireEvent.scroll(stage);
  expect((screen.getByLabelText("Word 页码") as HTMLInputElement).value).toBe(
    "1",
  );
  stage.scrollTop = 500;
  fireEvent.scroll(stage);
  expect((screen.getByLabelText("Word 页码") as HTMLInputElement).value).toBe(
    "2",
  );
});

it("late Word parsing cannot overwrite a newly selected file", async () => {
  let finish!: () => void;
  mocks.render
    .mockImplementationOnce(async (_bytes, target: HTMLElement) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      target.textContent = "old document";
    })
    .mockImplementationOnce(async (_bytes, target: HTMLElement) => {
      target.textContent = "new document";
    });
  const view = render(<DocxPreview dataBase64="AA==" onError={vi.fn()} />);
  await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
  view.rerender(<DocxPreview dataBase64="AQ==" onError={vi.fn()} />);
  await screen.findByText("new document");
  await act(async () => finish());
  expect(screen.queryByText("old document")).toBeNull();
  expect(screen.getByText("new document")).toBeTruthy();
});

it("releases presentation renderer after a pending parse finishes on an unmounted view", async () => {
  let finish!: () => void;
  const destroy = vi.fn();
  mocks.init.mockImplementation((target: HTMLElement) => ({
    destroy,
    preview: async () => {
      expect(target.isConnected).toBe(true);
      expect(target.style.visibility).toBe("hidden");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      expect(target.isConnected).toBe(true);
      target.textContent = "late slides";
    },
  }));
  const view = render(<PptxPreview dataBase64="AA==" onError={vi.fn()} />);
  await waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
  view.unmount();
  expect(destroy).not.toHaveBeenCalled();
  await act(async () => finish());
  await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("late slides")).toBeNull();
  expect(
    document.querySelector('[aria-hidden="true"][style*="960px"]'),
  ).toBeNull();
});

it("does not reparse Word for callback identity changes and reports the current error handler", async () => {
  let reject!: (error: Error) => void;
  mocks.render.mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const previous = vi.fn();
  const current = vi.fn();
  const view = render(<DocxPreview dataBase64="AA==" onError={previous} />);
  await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
  view.rerender(<DocxPreview dataBase64="AA==" onError={current} />);
  await act(async () => reject(new Error("invalid document")));
  expect(previous).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledWith("invalid document");
  expect(mocks.render).toHaveBeenCalledTimes(1);
  expect(
    view.container.querySelector(".office-preview")?.getAttribute("aria-busy"),
  ).toBe("false");
});

it("releases failed presentation parsing immediately and only once", async () => {
  const destroy = vi.fn();
  const onError = vi.fn();
  mocks.init.mockReturnValue({
    destroy,
    preview: vi.fn().mockRejectedValue(new Error("invalid slides")),
  });
  const view = render(<PptxPreview dataBase64="AA==" onError={onError} />);
  await waitFor(() => expect(onError).toHaveBeenCalledWith("invalid slides"));
  expect(
    view.container.querySelector(".office-preview")?.getAttribute("aria-busy"),
  ).toBe("false");
  expect(destroy).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(destroy).toHaveBeenCalledTimes(1);
});

it("finishes old presentation cleanup before another file can initialize charts", async () => {
  let finish!: () => void;
  const order: string[] = [];
  mocks.init
    .mockImplementationOnce(() => ({
      destroy: () => order.push("destroy old"),
      preview: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    }))
    .mockImplementationOnce((target: HTMLElement) => {
      order.push("init new");
      return {
        destroy: vi.fn(),
        preview: async () => {
          target.textContent = "new presentation";
        },
      };
    });
  const view = render(<PptxPreview dataBase64="AA==" onError={vi.fn()} />);
  await waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
  view.rerender(<PptxPreview dataBase64="AQ==" onError={vi.fn()} />);
  expect(mocks.init).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await screen.findByText("new presentation");
  expect(order).toEqual(["destroy old", "init new"]);
});
