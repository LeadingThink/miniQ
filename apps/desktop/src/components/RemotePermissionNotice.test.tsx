// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { DaemonEvent } from "../types";
import { RemotePermissionNotice } from "./RemotePermissionNotice";

vi.mock("../taskNotifications", () => ({ notifyRemotePermissionRaise: vi.fn(async () => true) }));

afterEach(cleanup);

function fixture(mode: "local" | "remote" = "local") {
  let emit!: (event: DaemonEvent) => void;
  const call = vi.fn().mockResolvedValue({ mode: "auto", effective: "auto" });
  const client = {
    mode,
    call,
    onEvent: (listener: (event: DaemonEvent) => void) => {
      emit = listener;
      return () => {};
    },
  } as unknown as RpcClient;
  return { client, call, emit: (event: unknown) => act(() => emit(event as DaemonEvent)) };
}

it("offers a one-click revert when a remote device raises a session", async () => {
  const { client, call, emit } = fixture();
  render(<RemotePermissionNotice client={client} />);
  emit({ type: "session_approval_changed", sessionId: "s1", mode: "fullAccess", actor: "remote:phone", previous: "auto", raised: true });
  expect(screen.getByRole("alert").textContent).toContain("phone");
  fireEvent.click(screen.getByRole("button", { name: "撤回" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(call).toHaveBeenCalledWith("session.approval.update", { sessionId: "s1", mode: "auto" });
});

it("ignores lowering and local changes, and stays silent on remote clients", () => {
  const { client, emit } = fixture();
  render(<RemotePermissionNotice client={client} />);
  emit({ type: "session_approval_changed", sessionId: "s1", mode: "alwaysAsk", actor: "remote:phone", previous: "auto" });
  emit({ type: "session_approval_changed", sessionId: "s1", mode: "fullAccess", previous: "auto", raised: true });
  expect(screen.queryByRole("alert")).toBeNull();
  cleanup();
  const onEvent = vi.fn();
  render(<RemotePermissionNotice client={{ mode: "remote", onEvent } as unknown as RpcClient} />);
  expect(onEvent).not.toHaveBeenCalled();
});
