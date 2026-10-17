// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { GitChangesPopover } from "./GitChangesPopover";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows workspace Git totals and opens the full changes view", async () => {
  const call = vi.fn(async () => ({
    root: "/project",
    branch: "main...origin/main",
    entries: [{ path: "src/app.ts" }, { path: "README.md" }],
    stats: { additions: 19, deletions: 4 },
  }));
  const onOpenAll = vi.fn();
  render(
    <GitChangesPopover
      client={{ call } as unknown as RpcClient}
      sessionId="session"
      refreshKey="initial"
      onOpenAll={onOpenAll}
    />,
  );

  const trigger = await screen.findByRole("button", { name: "查看 Git 变更" });
  expect(trigger.textContent).toContain("2");
  fireEvent.click(trigger);
  const popover = await screen.findByRole("dialog", { name: "Git 变更" });
  expect(popover.textContent).toContain("main");
  expect(popover.textContent).toContain("+19");
  expect(popover.textContent).toContain("-4");
  expect(popover.textContent).toContain("2 个文件");

  fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
  expect(onOpenAll).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Git 变更" })).toBeNull());
  expect(call).toHaveBeenCalledWith(
    "git.status",
    { sessionId: "session" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it("supports a running daemon whose Git status does not include totals yet", async () => {
  const call = vi.fn(async () => ({
    root: "/project",
    branch: "main",
    entries: [{ path: "src/app.ts" }],
  }));
  render(
    <GitChangesPopover
      client={{ call } as unknown as RpcClient}
      sessionId="session"
      refreshKey="initial"
      onOpenAll={vi.fn()}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "查看 Git 变更" }));
  const popover = await screen.findByRole("dialog", { name: "Git 变更" });
  expect(popover.textContent).toContain("+0");
  expect(popover.textContent).toContain("-0");
});