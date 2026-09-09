import { expect, it } from "vitest";
import {
  pdfRasterSize,
  PDF_MAX_CANVAS_PIXELS,
  PDF_MAX_CANVAS_SIDE,
} from "./documentPreviewModel";

it("keeps normal page density and bounds very large canvases without cropping the page", () => {
  expect(pdfRasterSize(600, 800, 2)).toEqual({
    width: 1200,
    height: 1600,
    ratio: 2,
  });
  for (const [width, height] of [
    [50_000, 50_000],
    [200, 50_000],
    [50_000, 200],
  ]) {
    const raster = pdfRasterSize(width, height, 3);
    expect(raster.width * raster.height).toBeLessThanOrEqual(
      PDF_MAX_CANVAS_PIXELS,
    );
    expect(Math.max(raster.width, raster.height)).toBeLessThanOrEqual(
      PDF_MAX_CANVAS_SIDE,
    );
    expect(Math.abs(raster.width - width * raster.ratio)).toBeLessThan(1);
    expect(Math.abs(raster.height - height * raster.ratio)).toBeLessThan(1);
  }
});

it("rejects invalid dimensions before allocating a canvas", () => {
  for (const dimension of [0, -1, Infinity, NaN])
    expect(() => pdfRasterSize(dimension, 100, 1)).toThrow();
});
