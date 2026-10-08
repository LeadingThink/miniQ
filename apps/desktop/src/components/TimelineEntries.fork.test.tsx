// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "../types";

vi.mock("./Md", () => ({
  Md: (props: { children: string }) => <div>{props.children}</div>,
}));

const { Timeline } = await import("./Timeline");

afterEach(cleanup);

const noop = () => undefined;
const asyncNoop = async () => undefined;
const none: never[] = [];

function message(id: string, role: Message["role"], minute: number): Message {
  return { id, sessionId: "s", role, content: `${role} ${id}`, createdAt: `2026-01-01T00:0${minute}:00Z` };
}

const messages = [
  message("u1", "user", 1),
  message("a1", "assistant", 2),
  message("u2", "user", 3),
  message("a2", "assistant", 4),
];

function view(busy: boolean, onFork: (id: string) => Promise<boolean>) {
  return (
    <Timeline
      messages={messages}
      toolCalls={none}
      approvals={none}
      questions={none}
      plan={none}
      artifacts={none}
      queue={none}
      streamingText=""
      turnProgress={null}
      busy={busy}
      onResolveApproval={noop}
      onResolveQuestion={noop}
      onRollback={noop}
      onOpenFile={noop}
      onOpenUrl={noop}
      onSteerQueued={asyncNoop}
      onRemoveQueued={asyncNoop}
      onUpdateQueued={asyncNoop}
      onRewrite={async () => true}
      onFork={onFork}
      onError={noop}
    />
  );
}

function forkButtons() {
  return screen.getAllByRole("button", { name: "分支到新聊天" }) as HTMLButtonElement[];
}

it("forks a completed reply while the session is running", () => {
  const onFork = vi.fn(async () => true);
  render(view(true, onFork));
  const [completed, running] = forkButtons();
  expect(completed.disabled).toBe(false);
  expect(running.disabled).toBe(true);
  expect(running.title).toBe("本轮完成后可分支");
  fireEvent.click(completed);
  expect(onFork).toHaveBeenCalledWith("a1");
});

it("forks any reply when the session is idle", () => {
  render(view(false, async () => true));
  expect(forkButtons().map((button) => button.disabled)).toEqual([false, false]);
});
