// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { FileDiff, SessionDiff } from "../types";
import { TurnChangesContext, turnHasFileWrites, type TurnChangesContextValue } from "../turnChanges";
import type { TimelineTurn } from "../timelineTurns";
import { TurnChangesCard } from "./TurnChangesCard";
import { ToastProvider } from "./ui";

afterEach(cleanup);

function file(path: string, additions: number, deletions: number, extra: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    absolutePath: `/work/${path}`,
    oldExists: true,
    newExists: true,
    binary: false,
    additions,
    deletions,
    hunks: [],
    ...extra,
  };
}

const FIVE_FILES: SessionDiff = {
  files: [
    file("src/a.ts", 3, 1),
    file("src/b.ts", 2, 0, { oldExists: false }),
    file("src/c.ts", 1, 1),
    file("src/d.ts", 4, 2),
    file("src/e.ts", 0, 5),
  ],
  additions: 10,
  deletions: 9,
};

type Handler = (method: string, params: Record<string, unknown>) => unknown;

function setup(handler: Handler, overrides: Partial<TurnChangesContextValue> = {}) {
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => handler(method, params));
  const value: TurnChangesContextValue = {
    client: { call } as unknown as RpcClient,
    sessionId: "s1",
    busy: false,
    epoch: 0,
    openReview: vi.fn(),
    onReverted: vi.fn(),
    ...overrides,
  };
  const view = render(
    <ToastProvider>
      <TurnChangesContext.Provider value={value}>
        <TurnChangesCard turnId="m1" />
      </TurnChangesContext.Provider>
    </ToastProvider>,
  );
  return { call, value, view };
}

const diffOnly: Handler = (method) => {
  if (method === "session.diff") return FIVE_FILES;
  throw new Error(`unexpected ${method}`);
};

describe("TurnChangesCard", () => {
  it("summarizes the turn and lists the first three files", async () => {
    const { call, value } = setup(diffOnly);
    expect(await screen.findByText("已编辑 5 个文件")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("session.diff", { sessionId: "s1", scope: "turn", turnId: "m1" });
    const card = screen.getByRole("region", { name: "本轮文件改动" });
    expect(within(card).getByText("+10")).toBeTruthy();
    expect(within(card).getByText("-9")).toBeTruthy();
    expect(within(card).getAllByRole("button", { name: /^查看 .* 的变更$/ })).toHaveLength(3);
    expect(within(card).getByText("新增")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "再显示 2 个文件" }));
    expect(within(card).getAllByRole("button", { name: /^查看 .* 的变更$/ })).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /再显示/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看 src/d.ts 的变更" }));
    expect(value.openReview).toHaveBeenLastCalledWith("m1", "src/d.ts");
    fireEvent.click(screen.getByRole("button", { name: "查看变更" }));
    expect(value.openReview).toHaveBeenLastCalledWith("m1");
  });

  it("renders nothing when the turn has no remaining changes", async () => {
    const { call, view } = setup(() => ({ files: [], additions: 0, deletions: 0 }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(view.container.querySelector(".turn-changes")).toBeNull();
  });

  it("refetches when the epoch changes", async () => {
    const { call, value, view } = setup(diffOnly);
    await screen.findByText("已编辑 5 个文件");
    view.rerender(
      <ToastProvider>
        <TurnChangesContext.Provider value={{ ...value, epoch: 1 }}>
          <TurnChangesCard turnId="m1" />
        </TurnChangesContext.Provider>
      </ToastProvider>,
    );
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  });

  it("disables undo while the session is running", async () => {
    setup(diffOnly, { busy: true });
    await screen.findByText("已编辑 5 个文件");
    expect((screen.getByRole("button", { name: "撤销" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("turn undo flow", () => {
  it("confirms before reverting and reports success with a toast", async () => {
    const { call, value } = setup((method) => method === "session.diff"
      ? FIVE_FILES
      : { reverted: true, restoredFiles: ["/work/src/a.ts", "/work/src/b.ts"], failedFiles: [], forced: false });
    await screen.findByText("已编辑 5 个文件");

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("撤销本轮修改？");
    expect(call).not.toHaveBeenCalledWith("session.revertTurn", expect.anything());

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "撤销" }));
    });
    expect(call).toHaveBeenCalledWith("session.revertTurn", { sessionId: "s1", turnId: "m1", force: false });
    expect(await screen.findByText("已撤销本轮修改，恢复 2 个文件")).toBeTruthy();
    expect(value.onReverted).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("lists files modified after the turn and offers a forced undo", async () => {
    let attempts = 0;
    const { call, value } = setup((method, params) => {
      if (method === "session.diff") return FIVE_FILES;
      attempts += 1;
      return params.force
        ? { reverted: true, restoredFiles: ["/work/src/a.ts"], failedFiles: [], forced: true }
        : {
            reverted: false,
            modifiedFiles: [{ path: "src/a.ts", absolutePath: "/work/src/a.ts", reason: "modified" }],
          };
    });
    await screen.findByText("已编辑 5 个文件");
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "撤销" }));
    });

    const conflict = await screen.findByRole("alertdialog", { name: "部分文件在本轮之后又被修改" });
    expect(within(conflict).getByText("src/a.ts")).toBeTruthy();
    expect(within(conflict).getByText("本轮后被修改")).toBeTruthy();
    expect(value.onReverted).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(conflict).getByRole("button", { name: "仍然撤销" }));
    });
    expect(call).toHaveBeenLastCalledWith("session.revertTurn", { sessionId: "s1", turnId: "m1", force: true });
    expect(attempts).toBe(2);
    expect(await screen.findByText("已撤销本轮修改，恢复 1 个文件")).toBeTruthy();
    expect(value.onReverted).toHaveBeenCalledTimes(1);
  });

  it("shows a failure toast when the revert request fails", async () => {
    setup((method) => {
      if (method === "session.diff") return FIVE_FILES;
      throw new Error("session already has an active turn (code -32003)");
    });
    await screen.findByText("已编辑 5 个文件");
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "撤销" }));
    });
    expect(await screen.findByText(/^撤销失败：/)).toBeTruthy();
  });
});

describe("turnHasFileWrites", () => {
  const turn = (toolName: string, filesChanged = 0): TimelineTurn => ({
    key: "k",
    userMessageId: "m1",
    timing: filesChanged
      ? { startedAt: "", status: "completed", summary: { toolCalls: 1, failedToolCalls: 0, filesChanged, status: "completed" } }
      : undefined,
    groups: [{
      kind: "tools",
      at: "2026-10-10T00:00:00Z",
      calls: [{ id: "t", sessionId: "s1", toolName, input: {}, status: "succeeded", createdAt: "2026-10-10T00:00:00Z" }],
    }] as TimelineTurn["groups"],
  });

  it("detects write tools or a files-changed summary", () => {
    expect(turnHasFileWrites(turn("apply_patch"))).toBe(true);
    expect(turnHasFileWrites(turn("shell_exec"))).toBe(false);
    expect(turnHasFileWrites(turn("shell_exec", 2))).toBe(true);
  });
});
