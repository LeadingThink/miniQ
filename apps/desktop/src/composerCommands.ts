import type { ComposerSlashCommand } from "./composerSlash";
import type { MiniqAppController } from "./hooks/useMiniqApp";
import type { Session } from "./types";

export interface ComposerCommandOptions {
  /** The shell owns the rename dialog and keeps its input out of the chat. */
  onRenameSession?: (session: Session) => void | Promise<void>;
  /** Close any competing workbench panel before showing changes. */
  onOpenReview?: () => void | Promise<void>;
}

function projectCommand(app: MiniqAppController): ComposerSlashCommand {
  const children: ComposerSlashCommand[] = app.catalog.workspaces.map(
    (workspace) => ({
      id: `project:${workspace.id}`,
      name: workspace.name,
      description: `${workspace.id === app.catalog.selectedWorkspaceId ? "当前项目 · " : ""}${workspace.path}`,
      group: "项目",
      keywords: [workspace.name, workspace.path, ...workspace.additionalPaths],
      icon: "project",
      selected: workspace.id === app.catalog.selectedWorkspaceId,
      onSelect: () => app.actions.selectWorkspace(workspace.id),
    }),
  );
  return {
    id: "project",
    name: "切换项目",
    description: "选择项目，开始其中的新会话",
    group: "会话",
    keywords: ["project", "workspace", "项目", "工作区"],
    icon: "project",
    children,
    disabled: children.length === 0,
    disabledReason:
      children.length === 0 ? "请先从新会话创建一个项目" : undefined,
  };
}

function sessionCommands(
  app: MiniqAppController,
  options: ComposerCommandOptions,
): ComposerSlashCommand[] {
  const session = app.catalog.currentSession;
  if (!session) return [];
  const active = app.busy || session.status === "cancelling";
  const hasCompletedTurn =
    Boolean(app.feed.nextCursor) ||
    (app.feed.messages.some((message) => message.role === "user") &&
      app.feed.messages.some((message) => message.role === "assistant"));
  const commands: ComposerSlashCommand[] = [
    {
      id: "pin",
      name: session.pinned ? "取消置顶" : "置顶会话",
      description: session.pinned
        ? "恢复会话在侧栏中的正常排序"
        : "将当前会话保留在侧栏顶部",
      group: "会话",
      keywords: ["pin", "star", "unpin", "置顶", "收藏"],
      icon: "context",
      onSelect: () => app.actions.setSessionPinned(session.id, !session.pinned),
    },
    {
      id: "archive",
      name: session.archived ? "恢复会话" : "归档会话",
      description: session.archived
        ? "将当前会话移回项目列表"
        : "收起当前会话，仍可从已归档中找回",
      group: "会话",
      keywords: ["archive", "restore", "归档", "恢复"],
      icon: "context",
      disabled: active,
      disabledReason: active ? "请在任务结束后归档" : undefined,
      onSelect: () =>
        active
          ? undefined
          : app.actions.setSessionArchived(session.id, !session.archived),
    },
    {
      id: "review",
      name: "查看文件改动",
      description: "在右侧查看当前会话修改的文件和差异",
      group: "工作流",
      keywords: ["review", "diff", "changes", "审查", "改动", "差异"],
      icon: "review",
      disabled: app.review.data.files.length === 0,
      disabledReason:
        app.review.data.files.length === 0 ? "当前会话暂无文件改动" : undefined,
      onSelect: () => {
        if (app.review.data.files.length === 0) return;
        if (options.onOpenReview) return options.onOpenReview();
        app.preview.close();
        app.review.setOpen(true);
      },
    },
    {
      id: "distill",
      name: "从会话提炼技能",
      description: "将已完成的工作方法整理为可复用的技能草稿",
      group: "扩展",
      keywords: ["distill", "learn", "skill", "提炼", "复用", "学习"],
      icon: "skills",
      disabled: active || app.feed.loading || !hasCompletedTurn,
      disabledReason: active
        ? "请在任务结束后提炼技能"
        : app.feed.loading
          ? "正在加载会话"
          : !hasCompletedTurn
            ? "至少完成一轮对话后可提炼技能"
            : undefined,
      onSelect: () => {
        if (!active && !app.feed.loading && hasCompletedTurn)
          app.navigation.setShowDistill(true);
      },
    },
  ];
  if (options.onRenameSession)
    commands.push({
      id: "rename",
      name: "重命名会话",
      description: "修改当前会话在侧栏中的标题",
      group: "会话",
      keywords: ["rename", "title", "名称", "标题", "重命名"],
      icon: "file",
      onSelect: () => options.onRenameSession?.(session),
    });
  return commands;
}

/** Commands call existing app actions; none rely on the model changing UI state. */
export function buildComposerSlashCommands(
  app: MiniqAppController,
  options: ComposerCommandOptions = {},
): ComposerSlashCommand[] {
  const remote = app.client.mode === "remote";
  return [
    {
      id: "new",
      name: "新建会话",
      description: "保留当前会话，开始一个新的会话",
      group: "会话",
      keywords: ["new", "chat", "新建", "会话"],
      icon: "new",
      onSelect: app.actions.newChat,
    },
    projectCommand(app),
    {
      id: "search",
      name: "搜索会话",
      description: "搜索会话标题和历史消息内容",
      group: "会话",
      keywords: ["search", "find", "查找", "搜索", "历史"],
      icon: "help",
      onSelect: () => app.navigation.setShowSearch(true),
    },
    ...sessionCommands(app, options),
    {
      id: "settings",
      name: "打开设置",
      description: "查看服务、权限、主题和连接设置",
      group: "设置与帮助",
      keywords: ["settings", "preferences", "配置", "设置", "权限", "主题"],
      icon: "settings",
      onSelect: () => app.navigation.setShowSettings(true),
    },
    {
      id: "skills",
      name: "管理技能",
      description: "查看当前项目可用的技能及启用状态",
      group: "扩展",
      keywords: ["skills", "skill", "技能"],
      icon: "skills",
      onSelect: () => app.navigation.setPage("skills"),
    },
    {
      id: "mcp",
      name: "管理工具连接",
      description: "查看已配置的 MCP 工具和连接状态",
      group: "扩展",
      keywords: ["mcp", "tools", "工具", "连接"],
      icon: "mcp",
      onSelect: () => app.navigation.setPage("mcp"),
    },
    {
      id: "plugins",
      name: "管理插件",
      description: "浏览已安装插件及其提供的能力",
      group: "扩展",
      keywords: ["plugin", "plugins", "插件", "扩展"],
      icon: "mcp",
      onSelect: () => app.navigation.setPage("plugins"),
    },
    {
      id: "schedule",
      name: "查看已安排任务",
      description: "打开计划任务和自动化列表",
      group: "工作流",
      keywords: ["schedule", "automation", "计划", "安排", "自动化"],
      icon: "context",
      onSelect: () => app.navigation.setPage("schedule"),
    },
    {
      id: "import",
      name: "导入其他客户端会话",
      description: "查看并导入 Codex、Claude Code 等客户端的会话",
      group: "工作流",
      keywords: ["import", "codex", "claude", "导入", "迁移"],
      icon: "file",
      disabled: remote,
      disabledReason: remote ? "请在桌面客户端导入会话" : undefined,
      onSelect: () => {
        if (!remote) app.navigation.setShowExternalImport(true);
      },
    },
  ];
}
