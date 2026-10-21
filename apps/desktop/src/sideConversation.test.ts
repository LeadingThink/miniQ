import { describe, expect, it, vi } from "vitest";
import { createSideConversationState, EMPTY_SIDE_CONVERSATION, isSideConversationExpired, releaseSideConversation } from "./sideConversation";

const session = { id: "side-1", workspaceId: "workspace-1" } as never;

describe("side conversation lifecycle", () => {
  it("expires only after the idle window", () => {
    const state = createSideConversationState(session, "main-1", 1000);
    expect(isSideConversationExpired(state, 1000 + 14 * 60 * 1000)).toBe(false);
    expect(isSideConversationExpired(state, 1000 + 15 * 60 * 1000)).toBe(true);
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