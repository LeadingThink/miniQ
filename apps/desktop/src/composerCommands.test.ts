import { describe, expect, it, vi } from "vitest";
import { buildComposerSlashCommands } from "./composerCommands";
import type { MiniqAppController } from "./hooks/useMiniqApp";

function fixture() {
  const app = {
    client: { mode: "local" },
    busy: false,
    catalog: {
      currentSession: null,
      selectedWorkspaceId: "one",
      workspaces: [
        {
          id: "one",
          name: "第一个项目",
          path: "/work/one",
          additionalPaths: ["/work/docs"],
        },
        {
          id: "two",
          name: "另一个项目",
          path: "/work/two",
          additionalPaths: [],
        },
      ],
    },
    actions: {
      newChat: vi.fn(),
      selectWorkspace: vi.fn(),
      setSessionPinned: vi.fn(),
      setSessionArchived: vi.fn(),
    },
    navigation: {
      setShowSearch: vi.fn(),
      setShowSettings: vi.fn(),
      setPage: vi.fn(),
      setShowExternalImport: vi.fn(),
      setShowDistill: vi.fn(),
    },
    feed: { loading: false, messages: [], nextCursor: null },
    review: { data: { files: [] }, setOpen: vi.fn() },
    preview: { close: vi.fn() },
  };
  return app as unknown as MiniqAppController;
}

function withSession(app: MiniqAppController) {
  app.catalog.currentSession = {
    id: "session-one",
    title: "当前任务",
    status: "idle",
    pinned: false,
    archived: false,
    workspaceId: "one",
    workingDirectory: "/work/one",
    createdAt: "now",
    updatedAt: "now",
  };
  return app;
}

function command(app: MiniqAppController, id: string) {
  const found = buildComposerSlashCommands(app).find((item) => item.id === id);
  if (!found) throw new Error(`Missing command ${id}`);
  return found;
}

describe("composer app commands", () => {
  it("opens actual app surfaces instead of asking a model to change state", async () => {
    const app = fixture();
    for (const id of ["new", "search", "settings", "import"]) {
      const item = command(app, id);
      expect(item.insertText).toBeUndefined();
      await item.onSelect?.();
    }
    expect(app.actions.newChat).toHaveBeenCalledOnce();
    expect(app.navigation.setShowSearch).toHaveBeenCalledWith(true);
    expect(app.navigation.setShowSettings).toHaveBeenCalledWith(true);
    expect(app.navigation.setShowExternalImport).toHaveBeenCalledWith(true);
    for (const id of ["skills", "mcp", "plugins", "schedule"]) {
      await command(app, id).onSelect?.();
      expect(app.navigation.setPage).toHaveBeenLastCalledWith(id);
    }
  });

  it("includes all projects and switches to the selected workspace", async () => {
    const app = fixture();
    const projects = command(app, "project");
    expect(projects.children?.map((item) => item.id)).toEqual([
      "project:one",
      "project:two",
    ]);
    expect(projects.children?.[0].description).toContain("当前项目");
    expect(projects.children?.[0].keywords).toContain("/work/docs");
    await projects.children?.[1].onSelect?.();
    expect(app.actions.selectWorkspace).toHaveBeenCalledWith("two");
    app.catalog.workspaces = [];
    expect(command(app, "project").disabledReason).toBe(
      "请先从新会话创建一个项目",
    );
  });

  it("does not register session actions in an unsaved draft", () => {
    const commands = buildComposerSlashCommands(fixture(), {
      onRenameSession: vi.fn(),
    });
    for (const id of ["pin", "archive", "rename", "distill", "review"]) {
      expect(commands.some((item) => item.id === id)).toBe(false);
    }
  });

  it("targets the current session for pin and archive actions", async () => {
    const app = withSession(fixture());
    await command(app, "pin").onSelect?.();
    await command(app, "archive").onSelect?.();
    expect(app.actions.setSessionPinned).toHaveBeenCalledWith(
      "session-one",
      true,
    );
    expect(app.actions.setSessionArchived).toHaveBeenCalledWith(
      "session-one",
      true,
    );
    app.catalog.currentSession!.pinned = true;
    app.catalog.currentSession!.archived = true;
    expect(command(app, "pin").name).toBe("取消置顶");
    expect(command(app, "archive").name).toBe("恢复会话");
  });

  it("keeps background work safe while still allowing navigation and pinning", async () => {
    const app = withSession(fixture());
    app.busy = true;
    for (const id of ["archive", "distill"]) {
      expect(command(app, id).disabled).toBe(true);
      await command(app, id).onSelect?.();
    }
    expect(app.actions.setSessionArchived).not.toHaveBeenCalled();
    expect(app.navigation.setShowDistill).not.toHaveBeenCalled();
    expect(command(app, "new").disabled).not.toBe(true);
    expect(command(app, "pin").disabled).not.toBe(true);
    app.busy = false;
    app.catalog.currentSession!.status = "cancelling";
    expect(command(app, "archive").disabled).toBe(true);
  });

  it("uses the shell rename dialog and passes the intended session", async () => {
    const app = withSession(fixture());
    expect(
      buildComposerSlashCommands(app).some((item) => item.id === "rename"),
    ).toBe(false);
    const rename = vi.fn().mockResolvedValue(undefined);
    const item = buildComposerSlashCommands(app, {
      onRenameSession: rename,
    }).find((entry) => entry.id === "rename")!;
    await item.onSelect?.();
    expect(rename).toHaveBeenCalledWith(app.catalog.currentSession);
  });

  it("enforces remote import restrictions while preserving supported navigation", async () => {
    const app = withSession(fixture());
    Object.defineProperty(app.client, "mode", { value: "remote" });
    expect(command(app, "import").disabledReason).toContain("桌面客户端");
    await command(app, "import").onSelect?.();
    expect(app.navigation.setShowExternalImport).not.toHaveBeenCalled();
    for (const id of [
      "settings",
      "skills",
      "mcp",
      "plugins",
      "search",
      "project",
    ]) {
      expect(command(app, id).disabled).not.toBe(true);
    }
    await command(app, "pin").onSelect?.();
    expect(app.actions.setSessionPinned).toHaveBeenCalledWith(
      "session-one",
      true,
    );
  });

  it("shows actual changed files in the workbench and supports its shell callback", async () => {
    const app = withSession(fixture());
    expect(command(app, "review").disabled).toBe(true);
    await command(app, "review").onSelect?.();
    expect(app.review.setOpen).not.toHaveBeenCalled();
    app.review.data.files = [
      {} as MiniqAppController["review"]["data"]["files"][number],
    ];
    await command(app, "review").onSelect?.();
    expect(app.preview.close).toHaveBeenCalledOnce();
    expect(app.review.setOpen).toHaveBeenCalledWith(true);
    const onOpenReview = vi.fn();
    await buildComposerSlashCommands(app, { onOpenReview })
      .find((item) => item.id === "review")!
      .onSelect?.();
    expect(onOpenReview).toHaveBeenCalledOnce();
  });

  it("only offers skill distillation after a completed exchange", async () => {
    const app = withSession(fixture());
    expect(command(app, "distill").disabled).toBe(true);
    app.feed.messages = [
      {
        id: "u",
        sessionId: "session-one",
        role: "user",
        content: "任务",
        createdAt: "now",
      },
      {
        id: "a",
        sessionId: "session-one",
        role: "assistant",
        content: "已完成",
        createdAt: "now",
      },
    ];
    expect(command(app, "distill").disabled).toBe(false);
    await command(app, "distill").onSelect?.();
    expect(app.navigation.setShowDistill).toHaveBeenCalledWith(true);
    app.feed.loading = true;
    expect(command(app, "distill").disabled).toBe(true);
  });
});
