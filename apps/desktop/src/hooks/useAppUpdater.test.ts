import { describe, expect, it } from "vitest";
import {
  applyDownloadEvent,
  isUnsupportedPlatformUpdateError,
  shouldCheckForUpdate,
  type AppUpdaterState,
} from "./useAppUpdater";

const DOWNLOADING: AppUpdaterState = {
  phase: "downloading",
  version: "0.2.0",
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};

describe("applyDownloadEvent", () => {
  it("tracks total and accumulated download bytes", () => {
    const started = applyDownloadEvent(DOWNLOADING, {
      event: "Started",
      data: { contentLength: 1_000 },
    });
    const progressed = applyDownloadEvent(started, {
      event: "Progress",
      data: { chunkLength: 250 },
    });

    expect(progressed.totalBytes).toBe(1_000);
    expect(progressed.downloadedBytes).toBe(250);
  });

  it("marks known-size downloads complete", () => {
    const finished = applyDownloadEvent(
      { ...DOWNLOADING, downloadedBytes: 750, totalBytes: 1_000 },
      { event: "Finished" },
    );

    expect(finished.downloadedBytes).toBe(1_000);
  });
});

describe("shouldCheckForUpdate", () => {
  it("checks again after the app has been open or hidden for one minute", () => {
    expect(shouldCheckForUpdate(1_000, 60_999)).toBe(false);
    expect(shouldCheckForUpdate(1_000, 61_000)).toBe(true);
  });
});

describe("isUnsupportedPlatformUpdateError", () => {
  it("recognizes a release manifest that has no package for this platform", () => {
    expect(
      isUnsupportedPlatformUpdateError(
        'None of the fallback platforms `["darwin-aarch64-app"]` were found in the response `platforms` object',
      ),
    ).toBe(true);
  });

  it("does not hide network and signature failures", () => {
    expect(isUnsupportedPlatformUpdateError("request timed out")).toBe(false);
  });
});
