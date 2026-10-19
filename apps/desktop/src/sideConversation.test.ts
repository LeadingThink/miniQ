import { describe, expect, it, vi } from "vitest";
import { createSideConversationState, EMPTY_SIDE_CONVERSATION, isSideConversationExpired, releaseSideConversation, sideConversationContext } from "./sideConversation";

const session = { id: "side-1", workspaceId: "workspace-1" } as never;

describe("side conversation lifecycle", () => {
  it("expires only after the idle window and keeps the current session as context", () => {
    const state = createSideConversationState(session, "main-1", 1000);
    expect(isSideConversationExpired(state, 1000 + 14 * 60 * 1000)).toBe(false);
    expect(isSideConversationExpired(state, 1000 + 15 * 60 * 1000)).toBe(true);
    expect(sideConversationContext(state, "workspace-1", "main-1")).toEqual({
      workspaceId: "workspace-1", sourceSessionId: "main-1", sideConversationId: "side-1",
    });
  });

  it("deletes the temporary session and clears all local references", async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const state = createSideConversationState(session, null, 1000);
    await expect(releaseSideConversation({ call } as never, state)).resolves.toEqual(EMPTY_SIDE_CONVERSATION);
    expect(call).toHaveBeenCalledWith("session.delete", { sessionId: "side-1" });
  });
});