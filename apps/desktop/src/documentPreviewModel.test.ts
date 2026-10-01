import { describe, expect, it } from "vitest";
import {
  clampPage,
  clampDocumentZoom,
  moveTabIndex,
  pdfLayout,
  pdfPageAt,
  pdfVisibleRange,
  spreadsheetColumnLabel,
  spreadsheetRow,
} from "./documentPreviewModel";

describe("document preview controls", () => {
  it("keeps PDF navigation inside the document", () => {
    expect(clampPage(0, 8)).toBe(1);
    expect(clampPage(5, 8)).toBe(5);
    expect(clampPage(20, 8)).toBe(8);
  });

  it("keeps PDF zoom usable and stable", () => {
    expect(clampDocumentZoom(0)).toBe(0.1);
    expect(clampDocumentZoom(1.399999)).toBe(1.4);
    expect(clampDocumentZoom(5)).toBe(4);
    expect(clampDocumentZoom(NaN)).toBe(1);
  });

  it("labels spreadsheet columns beyond Z", () => {
    expect(spreadsheetColumnLabel(0)).toBe("A");
    expect(spreadsheetColumnLabel(25)).toBe("Z");
    expect(spreadsheetColumnLabel(26)).toBe("AA");
    expect(spreadsheetColumnLabel(701)).toBe("ZZ");
  });

  it("wraps keyboard navigation through sheet tabs", () => {
    expect(moveTabIndex(0, 3, -1)).toBe(2);
    expect(moveTabIndex(2, 3, 1)).toBe(0);
  });

  it("pads short spreadsheet rows so columns remain aligned", () => {
    expect(spreadsheetRow(["A", "B"], 4)).toEqual(["A", "B", null, null]);
    expect(spreadsheetRow(["A", "B", "C"], 2)).toEqual(["A", "B"]);
  });
});

describe("continuous PDF layout", () => {
  const layout = pdfLayout(
    [
      { width: 100, height: 200 },
      { width: 200, height: 100 },
      { width: 100, height: 200 },
    ],
    () => 2,
    10,
  );

  it("stacks scaled pages with gaps and tracks the widest page", () => {
    expect(layout.offsets).toEqual([0, 410, 620]);
    expect(layout.total).toBe(1020);
    expect(layout.maxWidth).toBe(400);
  });

  it("finds the page at a scroll position with binary search", () => {
    expect(pdfPageAt(layout, -5)).toBe(1);
    expect(pdfPageAt(layout, 409)).toBe(1);
    expect(pdfPageAt(layout, 410)).toBe(2);
    expect(pdfPageAt(layout, 5000)).toBe(3);
  });

  it("returns only pages intersecting the viewport, skipping gaps", () => {
    expect(pdfVisibleRange(layout, 0, 300)).toEqual([1, 1]);
    expect(pdfVisibleRange(layout, 405, 700)).toEqual([2, 3]);
    expect(pdfVisibleRange(pdfLayout([], () => 1), 0, 10)).toEqual([1, 0]);
  });

  it("handles thousands of pages without DOM work", () => {
    const many = pdfLayout(
      Array.from({ length: 5000 }, () => ({ width: 600, height: 800 })),
      () => 1,
    );
    expect(pdfPageAt(many, 818 * 4321 + 1)).toBe(4322);
  });
});
