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
import { PdfPreview } from "./PdfPreview";
import { PreviewViewProvider, PreviewViewStore } from "../previewViewState";

const mocks = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("../pdfRuntime", () => ({
  loadPdfRuntime: async () => ({
    GlobalWorkerOptions: {},
    getDocument: mocks.getDocument,
    PasswordResponses: { INCORRECT_PASSWORD: 2 },
    TextLayer: class {
      private container: HTMLElement;
      constructor({ container }: { container: HTMLElement }) {
        this.container = container;
      }
      render() {
        this.container.textContent = "selectable layer";
        return Promise.resolve();
      }
      cancel() {}
    },
  }),
}));
afterEach(cleanup);
beforeEach(() => mocks.getDocument.mockReset());

it("restores page and actual zoom only for the same session and file", async () => {
  const store = new PreviewViewStore();
  const onError = vi.fn();
  documentFixture();
  const element = (scope: string) => (
    <PreviewViewProvider store={store} scope={scope} path="/a.pdf">
      <PdfPreview dataBase64="AA==" onError={onError} />
    </PreviewViewProvider>
  );
  const view = render(element("one"));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "下一页" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  fireEvent.click(screen.getByRole("button", { name: "放大 PDF" }));
  expect(
    view.container.querySelector(".pdf-page")?.getAttribute("data-fit"),
  ).toBe("false");
  view.rerender(element("two"));
  expect((screen.getByLabelText("PDF 页码") as HTMLInputElement).value).toBe(
    "1",
  );
  expect(
    view.container.querySelector(".pdf-page")?.getAttribute("data-fit"),
  ).toBe("true");
  view.rerender(element("one"));
  await waitFor(() => {
    if (onError.mock.calls.length) throw new Error(onError.mock.calls[0][0]);
    expect(mocks.getDocument.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  await waitFor(() =>
    expect((screen.getByLabelText("PDF 页码") as HTMLInputElement).value).toBe(
      "2",
    ),
  );
  expect(
    view.container.querySelector(".pdf-page")?.getAttribute("data-fit"),
  ).toBe("false");
});

function documentFixture(
  renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
) {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100_000 * scale,
      height: 50_000 * scale,
    }),
    render: renderPage,
    getTextContent: vi.fn().mockResolvedValue({ items: [{ str: "original" }] }),
    cleanup: vi.fn(),
  };
  const document = {
    numPages: 2000,
    getPage: vi.fn().mockResolvedValue(page),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  mocks.getDocument.mockReturnValue({
    promise: Promise.resolve(document),
    destroy: document.destroy,
  });
  return { page, document };
}

it("bounds raster memory and renders a selectable text layer for only the current page", async () => {
  const { page } = documentFixture();
  const view = render(<PdfPreview dataBase64="AA==" onError={vi.fn()} />);
  await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
  const canvas = view.container.querySelector("canvas")!;
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_777_216);
  expect(canvas.style.width).toBe("100000px");
  await screen.findByText("selectable layer");
  expect(page.getTextContent).toHaveBeenCalledTimes(1);
  expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
  fireEvent.click(screen.getByRole("checkbox", { name: "原文" }));
  await screen.findByText("original");
  expect(page.getTextContent).toHaveBeenCalledTimes(1);
});

it("packages compatibility resources locally and accepts password retries without saving the password", async () => {
  documentFixture();
  const view = render(<PdfPreview dataBase64="AA==" onError={vi.fn()} />);
  await waitFor(() => expect(mocks.getDocument).toHaveBeenCalled());
  expect(mocks.getDocument.mock.calls[0][0]).toMatchObject({
    cMapPacked: true,
    isEvalSupported: false,
    cMapUrl: expect.stringContaining("/pdfjs/cmaps/"),
    standardFontDataUrl: expect.stringContaining("/pdfjs/standard_fonts/"),
    wasmUrl: expect.stringContaining("/pdfjs/wasm/"),
  });
  const task = mocks.getDocument.mock.results[0].value;
  const update = vi.fn();
  act(() => task.onPassword(update, 2));
  expect(screen.getByRole("alert").textContent).toContain("密码不正确");
  fireEvent.change(screen.getByLabelText("PDF 密码"), {
    target: { value: "test-only" },
  });
  fireEvent.click(screen.getByRole("button", { name: "解锁" }));
  expect(update).toHaveBeenCalledWith("test-only");
  expect(view.container.querySelector('input[type="password"]')).toBeNull();
});

it("rerenders with a real fit scale on resize and keeps rotation in the viewport", async () => {
  let resize!: () => void;
  let width = 440;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const measured = vi
    .spyOn(HTMLElement.prototype, "clientWidth", "get")
    .mockImplementation(() => width);
  const { page } = documentFixture();
  const viewport = vi.spyOn(page, "getViewport");
  const view = render(<PdfPreview dataBase64="AA==" onError={vi.fn()} />);
  await waitFor(() =>
    expect(view.container.querySelector("canvas")?.style.width).toBe("440px"),
  );
  width = 320;
  act(() => resize());
  await waitFor(() =>
    expect(view.container.querySelector("canvas")?.style.width).toBe("320px"),
  );
  fireEvent.click(screen.getByRole("button", { name: "旋转 PDF" }));
  await waitFor(() =>
    expect(viewport).toHaveBeenLastCalledWith({ scale: 0.0032, rotation: 90 }),
  );
  measured.mockRestore();
  vi.unstubAllGlobals();
});

it("reports real render failures and starts a new renderer on retry", async () => {
  const failed = vi.fn(() => ({
    promise: Promise.reject(new Error("decoder failed")),
    cancel: vi.fn(),
  }));
  const { page, document } = documentFixture(failed);
  const onError = vi.fn();
  const view = render(
    <PdfPreview key={0} dataBase64="AA==" onError={onError} />,
  );
  await waitFor(() => expect(onError).toHaveBeenCalledWith("decoder failed"));
  expect(page.cleanup).toHaveBeenCalled();
  const next = documentFixture();
  view.rerender(<PdfPreview key={1} dataBase64="AA==" onError={onError} />);
  await waitFor(() => expect(next.page.render).toHaveBeenCalledTimes(1));
  expect(document.destroy).toHaveBeenCalledTimes(1);
});

it("stops the loading state when the document cannot be decoded", async () => {
  mocks.getDocument.mockReturnValue({
    promise: Promise.reject(new Error("bad PDF")),
    destroy: vi.fn().mockResolvedValue(undefined),
  });
  const onError = vi.fn();
  const view = render(<PdfPreview dataBase64="AA==" onError={onError} />);
  await waitFor(() => expect(onError).toHaveBeenCalledWith("bad PDF"));
  expect(
    view.container.querySelector(".pdf-stage")?.getAttribute("aria-busy"),
  ).toBe("false");
  expect(view.container.querySelector(".document-loading")).toBeNull();
});

it("cancels obsolete rendering and does not reload for callback identity changes", async () => {
  let reject!: (error: Error) => void;
  const cancel = vi.fn(() =>
    reject(
      Object.assign(new Error("cancelled"), {
        name: "RenderingCancelledException",
      }),
    ),
  );
  const renderPage = vi
    .fn()
    .mockReturnValueOnce({
      promise: new Promise<void>((_, fail) => {
        reject = fail;
      }),
      cancel,
    })
    .mockImplementation(() => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }));
  const { document } = documentFixture(renderPage);
  const view = render(<PdfPreview dataBase64="AA==" onError={() => {}} />);
  await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
  const onError = vi.fn();
  view.rerender(<PdfPreview dataBase64="AA==" onError={onError} />);
  expect(mocks.getDocument).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  await act(async () => view.unmount());
  expect(document.destroy).toHaveBeenCalledTimes(1);
});
