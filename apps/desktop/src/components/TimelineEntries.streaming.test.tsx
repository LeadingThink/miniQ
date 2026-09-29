// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "../types";

const rendered: string[] = [];
vi.mock("./Md", () => ({
  Md: (props: { children: string }) => {
    rendered.push(props.children);
    return <div>{props.children}</div>;
  },
}));

const { Timeline } = await import("./Timeline");

afterEach(cleanup);

const noop = () => undefined;
const asyncNoop = async () => undefined;

function message(id: string, role: Message["role"], content: string): Message {
  return { id, sessionId: "s", role, content, createdAt: "2026-01-01T00:00:00Z" };
}

const messages = Array.from({ length: 20 }, (_, index) =>
  message(`m${index}`, index % 2 ? "assistant" : "user", `历史回复 ${index}`),
);

// The session feed reducer keeps these identities while only streamingText grows.
const none: never[] = [];

function view(streamingText: string, onOpenFile = noop) {
  return (
    <Timeline
      messages={messages}
      toolCalls={none}
      approvals={none}
      questions={none}
      plan={none}
      artifacts={none}
      queue={none}
      streamingText={streamingText}
      turnProgress={null}
      busy
      onResolveApproval={noop}
      onResolveQuestion={noop}
      onRollback={noop}
      onOpenFile={onOpenFile}
      onOpenUrl={noop}
      onSteerQueued={asyncNoop}
      onRemoveQueued={asyncNoop}
      onUpdateQueued={asyncNoop}
      onRewrite={async () => true}
      onError={noop}
    />
  );
}

it("streams new tokens without re-rendering completed history", () => {
  const { rerender } = render(view("正在"));
  expect(screen.getByText("历史回复 19")).toBeTruthy();
  rendered.length = 0;
  // Parents commonly pass fresh callback identities on every token.
  rerender(view("正在生成", () => undefined));
  rerender(view("正在生成回复", () => undefined));
  expect(rendered).toEqual(["正在生成", "正在生成回复"]);
});
