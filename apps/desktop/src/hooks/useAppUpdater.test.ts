import { describe, expect, it } from "vitest";
import { applyDownloadEvent, type AppUpdaterState } from "./useAppUpdater";

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
