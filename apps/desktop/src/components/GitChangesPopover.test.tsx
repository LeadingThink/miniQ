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

it("paints a conversation's own cached count when returning to it", async () => {
  const call = vi.fn(async () => ({
    root: "/project",
    branch: "main",
    entries: [{ path: "a" }, { path: "b" }, { path: "c" }],
  }));
  const client = { call } as unknown as RpcClient;
  const view = render(
    <GitChangesPopover client={client} sessionId="first" refreshKey="k" onOpenAll={vi.fn()} />,
  );
  expect((await screen.findByRole("button", { name: "查看 Git 变更" })).textContent).toContain("3");

  view.rerender(
    <GitChangesPopover client={client} sessionId="second" refreshKey="k" onOpenAll={vi.fn()} />,
  );
  view.rerender(
    <GitChangesPopover client={client} sessionId="first" refreshKey="k" onOpenAll={vi.fn()} />,
  );
  expect(screen.getByRole("button", { name: "查看 Git 变更" }).textContent).toContain("3");
});

it("hides the count while another conversation has no snapshot yet", async () => {
  const pending = new Promise(() => {});
  const call = vi.fn()
    .mockResolvedValueOnce({ root: "/project", branch: "main", entries: [{ path: "a" }, { path: "b" }] })
    .mockReturnValueOnce(pending);
  const client = { call } as unknown as RpcClient;
  const view = render(
    <GitChangesPopover client={client} sessionId="first" refreshKey="k" onOpenAll={vi.fn()} />,
  );
  expect((await screen.findByRole("button", { name: "查看 Git 变更" })).textContent).toContain("2");

  view.rerender(
    <GitChangesPopover client={client} sessionId="second" refreshKey="k" onOpenAll={vi.fn()} />,
  );
  expect(screen.queryByRole("button", { name: "查看 Git 变更" })).toBeNull();
});