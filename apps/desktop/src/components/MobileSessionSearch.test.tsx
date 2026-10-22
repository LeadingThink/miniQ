// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { Message } from "../types";
import { MobileSessionSearch } from "./MobileSessionSearch";

afterEach(cleanup);

const messages: Message[] = [
  { id: "m1", sessionId: "s1", role: "user", content: "检查更新失败，看下 CDN 节点", createdAt: "2026-10-22T10:00:00Z" },
  { id: "m2", sessionId: "s1", role: "assistant", content: "运行 `curl` 之后确认超时", createdAt: "2026-10-22T10:05:00Z" },
  { id: "m3", sessionId: "other", role: "user", content: "别的会话里的检查更新", createdAt: "2026-10-22T10:06:00Z" },
] as Message[];

function renderSheet(query: string, onLocate = vi.fn()) {
  const call = vi.fn(async () => ({ matches: messages }));
  render(
    <MobileSessionSearch
      client={{ call } as unknown as RpcClient}
      sessionId="s1"
      query={query}
      onQuery={vi.fn()}
      onClose={vi.fn()}
      onLocate={onLocate}
    />,
  );
  return { call, onLocate };
}

it("searches only the current conversation and highlights the hit", async () => {
  const { call } = renderSheet("检查更新");

  await waitFor(() => expect(document.querySelectorAll(".mobile-session-search-card")).toHaveLength(2));
  expect(call).toHaveBeenCalledWith("session.search", { query: "检查更新", limit: 50 });
  expect(screen.queryByText(/别的会话里的检查更新/)).toBeNull();
  expect(document.querySelector(".mobile-session-search-hit")?.textContent).toBe("检查更新");
});

it("filters by code blocks and a card opens its record", async () => {
  const { onLocate } = renderSheet("检查更新");

  await waitFor(() => expect(document.querySelectorAll(".mobile-session-search-card")).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "包含代码" }));
  await waitFor(() => expect(document.querySelectorAll(".mobile-session-search-card")).toHaveLength(1));

  fireEvent.click(document.querySelector(".mobile-session-search-card")!);
  expect(onLocate).toHaveBeenCalledWith(expect.objectContaining({ id: "m2" }));
});

it("prompts for a keyword before searching", () => {
  renderSheet("");

  expect(screen.getByText(/输入关键词/)).toBeTruthy();
  expect(document.querySelectorAll(".mobile-session-search-card")).toHaveLength(0);
});
