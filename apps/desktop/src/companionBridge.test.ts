// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { dispatchCompanionNavigation, initializeCompanionBridge, isCompanionDestination, subscribeCompanionNavigation } from "./companionBridge";

it("session navigation always carries local workspace/session IDs, preserving early requests", () => {
  expect(isCompanionDestination({ action: "session", sessionId: "s" })).toBe(false);
  expect(isCompanionDestination({ action: "session", workspaceId: "w", sessionId: "\n" })).toBe(false);
  expect(isCompanionDestination({ action: "voice", workspaceId: "w" })).toBe(true);
  expect(dispatchCompanionNavigation({ action: "session", workspaceId: "w", sessionId: "s" })).toBe(true);
  const handler = vi.fn(); const off = subscribeCompanionNavigation(handler);
  expect(handler).toHaveBeenCalledWith({ action: "session", workspaceId: "w", sessionId: "s" });
  dispatchCompanionNavigation({ action: "settings" });
  expect(handler).toHaveBeenCalledWith({ action: "settings" }); off();
});
it("cleans up a native listen promise that resolves after bridge disposal", async () => {
  const unlisten = vi.fn(); const listen = vi.fn(async () => unlisten);
  const dispose = initializeCompanionBridge(listen); dispose();
  await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  expect(listen).toHaveBeenCalledWith("companion:navigate", expect.any(Function));
});
