import { describe, expect, it } from "vitest";
import {
  clampPage,
  clampPdfZoom,
  moveTabIndex,
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
    expect(clampPdfZoom(0.1)).toBe(0.6);
    expect(clampPdfZoom(1.399999)).toBe(1.4);
    expect(clampPdfZoom(4)).toBe(2);
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
