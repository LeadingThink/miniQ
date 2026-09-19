// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserScriptResult } from "./browserAutomationScript";
import { waitForBrowserObservation } from "./browserObservationWait";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function page(url: string, documentId: string, readyState: DocumentReadyState = "complete"): BrowserScriptResult {
  return {
    observationId: "observation", url, documentId, readyState, title: "Page", tabId: "view",
    viewport: { width: 800, height: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
    items: [], textLines: [url], offset: 0, limit: 100, total: 0, totalTextLines: 1, hasMore: false,
  };
}

it("waits through a stable old page until delayed navigation and redirects commit", async () => {
  const previous = page("https://old.test/", "old-document");
  let current = previous;
  const observe = vi.fn(async () => current);
  const finish = vi.fn();
  const waiting = waitForBrowserObservation(observe, { url: "https://requested.test/", previous });
  void waiting.then(finish);
  await vi.advanceTimersByTimeAsync(2_400);
  expect(finish).not.toHaveBeenCalled();
  current = page("https://redirected.test/", "new-document", "loading");
  await vi.advanceTimersByTimeAsync(1_200);
  expect(finish).not.toHaveBeenCalled();
  current = { ...current, readyState: "complete" };
  await vi.advanceTimersByTimeAsync(400);
  await expect(waiting).resolves.toEqual(current);
});

it("never treats an initial about:blank document as the loaded website", async () => {
  let current = page("about:blank", "empty");
  const waiting = waitForBrowserObservation(async () => current, { url: "https://example.test/" });
  const finish = vi.fn();
  void waiting.then(finish);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(finish).not.toHaveBeenCalled();
  current = page("https://example.test/", "real-page");
  await vi.advanceTimersByTimeAsync(400);
  await expect(waiting).resolves.toEqual(current);
});

it("waits for document replacement even when reloading the same URL", async () => {
  const previous = page("https://example.test/", "old-document");
  let current = previous;
  const waiting = waitForBrowserObservation(async () => current, { url: previous.url, previous });
  const finish = vi.fn();
  void waiting.then(finish);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(finish).not.toHaveBeenCalled();
  current = { ...previous, documentId: "new-document" };
  await vi.advanceTimersByTimeAsync(400);
  await expect(waiting).resolves.toEqual(current);
});

it("accepts an explicit same-document fragment navigation", async () => {
  const previous = page("https://example.test/#first", "same-document");
  const next = { ...previous, url: "https://example.test/#second" };
  const waiting = waitForBrowserObservation(async () => next, { url: next.url, previous });
  await vi.advanceTimersByTimeAsync(400);
  await expect(waiting).resolves.toEqual(next);
});

it("times out failed navigation instead of returning old or loading content", async () => {
  const previous = page("https://example.test/", "old-document");
  const waiting = waitForBrowserObservation(async () => previous, { url: "https://unreachable.test/", previous });
  const assertion = expect(waiting).rejects.toThrow("未将旧页面或空白页当成导航结果");
  await vi.advanceTimersByTimeAsync(30_100);
  await assertion;
});

it("does not return a stale sample after a subsequent navigation error", async () => {
  let calls = 0;
  const waiting = waitForBrowserObservation(async () => {
    if (++calls === 1) return page("https://example.test/", "old-document");
    throw new Error("navigation interrupted JavaScript evaluation");
  });
  const assertion = expect(waiting).rejects.toThrow("navigation interrupted");
  await vi.advanceTimersByTimeAsync(2_000);
  await assertion;
});

it("allows a committed live-updating page without requiring network idle", async () => {
  let sample = 0;
  const waiting = waitForBrowserObservation(async () => ({
    ...page("https://live.test/", "live-document"), textLines: [String(++sample)],
  }), { url: "https://live.test/" });
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(waiting).resolves.toMatchObject({ documentId: "live-document" });
});

it("does not claim same-URL reload success when the previous document identity is unavailable", async () => {
  const current = page("https://example.test/", "unknown-document");
  const waiting = waitForBrowserObservation(async () => current, { url: current.url, previous: { url: current.url } });
  const assertion = expect(waiting).rejects.toThrow("未将旧页面或空白页当成导航结果");
  await vi.advanceTimersByTimeAsync(30_100);
  await assertion;
});

it("requires a fresh observation when neither the previous document nor native URL was readable", async () => {
  const observe = vi.fn(async () => page("https://old.test/", "old"));
  await expect(waitForBrowserObservation(observe, { url: "https://new.test/", previousUnavailable: true }))
    .rejects.toThrow("导航已发出");
  expect(observe).not.toHaveBeenCalled();
});
