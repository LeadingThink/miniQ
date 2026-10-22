// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSideConversationState, EMPTY_SIDE_CONVERSATION, isSideConversationExpired, readStoredSideConversation, releaseSideConversation, sideConversationStorageKey, storeSideConversation } from "./sideConversation";

const session = { id: "side-1", workspaceId: "workspace-1" } as never;

describe("side conversation lifecycle", () => {
  it("keeps a side chat for three idle hours", () => {
    const state = createSideConversationState(session, "main-1", 1000);
    expect(isSideConversationExpired(state, 1000 + 2 * 60 * 60 * 1000)).toBe(false);
    expect(isSideConversationExpired(state, 1000 + 3 * 60 * 60 * 1000)).toBe(true);
    expect(isSideConversationExpired(state, 1000 + 15 * 60 * 1000, 15 * 60 * 1000)).toBe(true);
  });

  it("round-trips the stored side conversation per host", () => {
    const key = sideConversationStorageKey("build-host");
    expect(key).toBe("miniq.sideConversation.build-host");
    const state = createSideConversationState(session, "main-1", 1000);
    storeSideConversation(key, state);
    expect(readStoredSideConversation(key)).toEqual(state);
    expect(readStoredSideConversation(sideConversationStorageKey(null))).toBeNull();
  });

  it("cancels a running turn and deletes the side session", async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const state = createSideConversationState(session, null, 1000);
    await expect(releaseSideConversation({ call } as never, state, { cancel: true })).resolves.toEqual(EMPTY_SIDE_CONVERSATION);
    expect(call).toHaveBeenNthCalledWith(1, "session.cancel", { sessionId: "side-1" });
    expect(call).toHaveBeenNthCalledWith(2, "session.delete", { sessionId: "side-1" });
  });

  it("deletes without cancelling when no turn is running", async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const state = createSideConversationState(session, null, 1000);
    await releaseSideConversation({ call } as never, state);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("session.delete", { sessionId: "side-1" });
  });
});