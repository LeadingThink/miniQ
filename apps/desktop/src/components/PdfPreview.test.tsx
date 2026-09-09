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
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  getDocument: mocks.getDocument,
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({
  default: "worker",
}));
afterEach(cleanup);
beforeEach(() => mocks.getDocument.mockReset());

it("restores page and actual zoom only for the same session and file", async () => {
  const store = new PreviewViewStore();
  documentFixture();
  const element = (scope: string) => (
    <PreviewViewProvider store={store} scope={scope} path="/a.pdf">
      <PdfPreview dataBase64="AA==" onError={vi.fn()} />
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

it("bounds raster memory, renders one page and extracts text only on request", async () => {
  const { page } = documentFixture();
  const view = render(<PdfPreview dataBase64="AA==" onError={vi.fn()} />);
  await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
  const canvas = view.container.querySelector("canvas")!;
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_777_216);
  expect(canvas.style.width).toBe("135000px");
  expect(page.getTextContent).not.toHaveBeenCalled();
  expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
  fireEvent.click(screen.getByRole("checkbox", { name: "原文" }));
  await screen.findByText("original");
  expect(page.getTextContent).toHaveBeenCalledTimes(1);
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
