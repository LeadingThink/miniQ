// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { FileDiff, SessionDiff } from "../types";
import { useSessionDiff } from "../hooks/useSessionDiff";
import { ReviewPanel } from "./ReviewPanel";

afterEach(cleanup);

function file(path: string): FileDiff {
  return {
    path,
    absolutePath: `/work/${path}`,
    oldExists: true,
    newExists: true,
    binary: false,
    additions: 1,
    deletions: 0,
    hunks: [],
  };
}

const SESSION: SessionDiff = { files: [file("a.ts"), file("b.ts")], additions: 2, deletions: 0 };
const TURN: SessionDiff = { files: [file("b.ts")], additions: 1, deletions: 0 };

describe("ReviewPanel scope", () => {
  it("toggles between this turn and all changes", () => {
    const onScopeChange = vi.fn();
    render(
      <ReviewPanel diff={SESSION} scope="session" onScopeChange={onScopeChange} onOpenFile={vi.fn()} onClose={vi.fn()} />,
    );
    const all = screen.getByRole("button", { name: "全部" });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "本轮" }));
    expect(onScopeChange).toHaveBeenCalledWith("turn");
  });

  it("selects the focused file", () => {
    render(
      <ReviewPanel
        diff={SESSION}
        scope="turn"
        onScopeChange={vi.fn()}
        focus={{ path: "b.ts", nonce: 1 }}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "本轮" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { current: true }).textContent).toContain("b.ts");
  });
});

describe("useSessionDiff scope", () => {
  it("keeps session totals while the panel shows one turn", async () => {
    const call = vi.fn(async (_method: string, params: { scope?: string }) =>
      params.scope === "turn" ? TURN : SESSION);
    const client = { call } as unknown as RpcClient;
    const { result } = renderHook(() => useSessionDiff(client, "s1", [], "latest"));
    await waitFor(() => expect(result.current.data).toEqual(SESSION));
    expect(result.current.view.diff).toEqual(SESSION);

    act(() => result.current.showTurn("m1", "b.ts"));
    await waitFor(() => expect(result.current.view.diff).toEqual(TURN));
    expect(call).toHaveBeenCalledWith("session.diff", { sessionId: "s1", scope: "turn", turnId: "m1" });
    expect(result.current.data).toEqual(SESSION);
    expect(result.current.focus?.path).toBe("b.ts");

    act(() => result.current.showSession());
    expect(result.current.scope).toBe("session");
    act(() => result.current.setScope("turn"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("session.diff", { sessionId: "s1", scope: "turn", turnId: "latest" }));

    const before = call.mock.calls.length;
    act(() => result.current.filesRestored());
    await waitFor(() => expect(call.mock.calls.length).toBe(before + 2));
  });
});
