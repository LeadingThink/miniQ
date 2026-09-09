import { expect, it, vi } from "vitest";
import { pdfText, searchPdf } from "./pdfSearch";

it("searches every page and retains Unicode and repeated matches", async () => {
  const pages = ["first", "计划 计划", "last 计划"];
  const document = {
    numPages: 3,
    getPage: async (page: number) => ({
      getTextContent: async () => ({ items: [{ str: pages[page - 1] }] }),
    }),
  };
  const progress = vi.fn();
  expect(
    await searchPdf(document, "计划", new AbortController().signal, progress),
  ).toEqual([
    { page: 2, count: 2 },
    { page: 3, count: 1 },
  ]);
  expect(progress).toHaveBeenLastCalledWith(3);
  expect(pdfText([{ str: "A", hasEOL: true }, {}, { str: "B" }])).toBe("A\nB");
});

it("stops before another page after cancellation", async () => {
  const controller = new AbortController();
  const getPage = vi.fn(async () => ({
    getTextContent: async () => ({ items: [{ str: "term" }] }),
  }));
  await expect(
    searchPdf({ numPages: 20, getPage }, "term", controller.signal, () =>
      controller.abort(),
    ),
  ).rejects.toThrow();
  expect(getPage).toHaveBeenCalledTimes(1);
});

it("releases page resources even if parsing fails or a scan is cancelled", async () => {
  const cleanup = vi.fn();
  const document = {
    numPages: 5000,
    getPage: vi.fn(async () => ({
      cleanup,
      getTextContent: async () => {
        throw new Error("bad page");
      },
    })),
  };
  await expect(
    searchPdf(document, "term", new AbortController().signal, vi.fn()),
  ).rejects.toThrow("bad page");
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(document.getPage).toHaveBeenCalledTimes(1);
});
