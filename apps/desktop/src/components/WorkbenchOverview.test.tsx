// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { WorkbenchOverview } from "./WorkbenchOverview";

afterEach(cleanup);

it("keeps project browsing available before a session has a plan or deliveries", async () => {
  const call = vi.fn().mockResolvedValue({
    path: "/project",
    parent: null,
    roots: ["/project"],
    nextCursor: null,
    entries: [
      {
        name: "完整文件名.md",
        path: "/project/完整文件名.md",
        directory: false,
        size: 12,
      },
    ],
  });
  const app = {
    client: { mode: "local", call },
    catalog: {
      currentSessionId: "session",
      currentSession: { title: "新任务" },
      currentWorkspacePaths: [],
    },
    feed: { artifacts: [], plan: [], nextCursor: null },
    preview: { canReopenClosedTab: false },
  } as unknown as MiniqAppController;
  const onOpenFile = vi.fn();
  render(
    <WorkbenchOverview
      app={app}
      onOpenFile={onOpenFile}
      launcher={{ onOpenFiles: vi.fn() }}
    />,
  );
  expect(screen.getByRole("region", { name: "任务计划" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "浏览项目文件" }));
  fireEvent.click(await screen.findByRole("button", { name: /完整文件名.md/ }));
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith({
    path: "/project/完整文件名.md",
    line: null,
    column: null,
  });
  expect(call.mock.calls[0][1]).toMatchObject({
    sessionId: "session",
    path: "",
  });
});
