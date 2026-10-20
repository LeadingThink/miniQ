import { describe, expect, it } from "vitest";
import {
  applyDownloadEvent,
  isUnsupportedPlatformUpdateError,
  shouldCheckForUpdate,
  updateBusyReason,
  type AppUpdaterState,
} from "./useAppUpdater";

const DOWNLOADING: AppUpdaterState = {
  phase: "downloading",
  version: "0.2.0",
  downloadedBytes: 0,
  totalBytes: null,
  releaseNotes: [],
  error: null,
  busyReason: null,
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

describe("updateBusyReason", () => {
  it("classifies daemon busy responses without treating them as failures", () => {
    expect(updateBusyReason("miniQ still has active tasks or requests; retry the update when idle")).toBe("active-task");
    expect(updateBusyReason("miniQ has queued messages; wait for them or explicitly remove them before updating")).toBe("queued-messages");
    expect(updateBusyReason("任务执行中，请等待任务完成后更新。")).toBe("active-task");
    expect(updateBusyReason("signature invalid")).toBeNull();
  });
});

import { parseReleaseNotes } from "./useAppUpdater";
describe("parseReleaseNotes", () => {
  it("returns clean display lines without list markers or blanks", () => {
    expect(parseReleaseNotes("- 新增上传\r\n* 修复加载\n\n1. 更快启动\n  2) 其他")).toEqual(["新增上传", "修复加载", "更快启动", "其他"]);
  });
  it("tolerates missing bodies", () => {
    expect(parseReleaseNotes(undefined)).toEqual([]);
    expect(parseReleaseNotes(null)).toEqual([]);
    expect(parseReleaseNotes("   ")).toEqual([]);
  });
});
