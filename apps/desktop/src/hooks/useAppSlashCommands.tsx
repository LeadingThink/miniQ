import { useEffect, useRef, useState } from "react";
import type { MiniqAppController } from "./useMiniqApp";
import type { ComposerSlashCommand } from "../composerSlash";
import { buildComposerSlashCommands } from "../composerCommands";
import { buildModelSlashCommands } from "../modelSlashCommands";
import { SessionShareDialog } from "../components/SessionShareDialog";
import { ModelDiagnostics } from "../components/ModelDiagnostics";
import { STARTER_PROMPTS } from "../components/StarterPrompts";
import { errorMessage } from "../errorMessage";

function RenameSessionDialog(props: {
  title: string;
  onSave: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(props.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="slash-rename-dialog"
      aria-labelledby="slash-rename-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) props.onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim() || saving) return;
          setSaving(true);
          void props
            .onSave(title.trim())
            .then(props.onClose)
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => setSaving(false));
        }}
      >
        <h2 id="slash-rename-title">重命名会话</h2>
        <label>
          会话标题
          <input
            autoFocus
            value={title}
            disabled={saving}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={saving} onClick={props.onClose}>
            取消
          </button>
          <button type="submit" disabled={saving || !title.trim()}>
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function useAppSlashCommands(
  app: MiniqAppController,
  options: { onOpenBrowser: () => void; onOpenReview: () => void },
) {
  const [overlay, setOverlay] = useState<{
    kind: "share" | "rename" | "usage";
    sessionId: string;
  } | null>(null);
  const session = app.catalog.currentSession;
  const commands: ComposerSlashCommand[] = [
    ...buildModelSlashCommands(app.client, app.sessionModel, Boolean(app.busy)),
    ...buildComposerSlashCommands(app, {
      onOpenReview: options.onOpenReview,
      onRenameSession: (target) =>
        setOverlay({ kind: "rename", sessionId: target.id }),
    }),
    {
      id: "browser",
      name: "打开内置浏览器",
      group: "工具",
      icon: "browser",
      description: "在右侧打开浏览器，保留当前会话",
      keywords: ["browser", "web", "网页", "浏览器"],
      onSelect: options.onOpenBrowser,
    },
    {
      id: "task",
      name: "选择任务模板",
      group: "工作流",
      icon: "context",
      description: "添加任务草稿，补充要求后发送",
      keywords: ["task", "prompt", "模板", "开发", "审查", "修复"],
      children: STARTER_PROMPTS.map((prompt) => ({
        id: `task:${prompt.id}`,
        name: prompt.title,
        description: prompt.description,
        group: "任务模板",
        icon: "context",
        insertText: prompt.prompt,
      })),
    },
  ];
  if (session)
    commands.push(
      {
        id: "share",
        name: "分享会话",
        description: "选择消息和文件，预览并创建分享链接",
        group: "工作流",
        icon: "share",
        keywords: ["share", "分享", "链接"],
        onSelect: () => setOverlay({ kind: "share", sessionId: session.id }),
      },
      {
        id: "usage",
        name: "模型调用与用量",
        description: "查看 Token 用量、重试和上下文压缩记录",
        group: "设置与帮助",
        icon: "context",
        keywords: [
          "usage",
          "status",
          "tokens",
          "用量",
          "诊断",
          "上下文",
          "重试",
        ],
        onSelect: () => setOverlay({ kind: "usage", sessionId: session.id }),
      },
    );
  useEffect(() => {
    setOverlay(null);
  }, [session?.id]);
  const onClose = () => setOverlay(null);
  const dialogs =
    overlay && session?.id === overlay.sessionId ? (
      overlay.kind === "share" ? (
        <SessionShareDialog
          client={app.client}
          sessionId={session.id}
          title={session.title}
          artifacts={app.feed.artifacts}
          onClose={onClose}
        />
      ) : overlay.kind === "usage" ? (
        <ModelDiagnostics
          client={app.client}
          sessionId={session.id}
          onClose={onClose}
        />
      ) : (
        <RenameSessionDialog
          title={session.title}
          onSave={async (title) => {
            await app.client.call("session.rename", {
              sessionId: session.id,
              title,
            });
            await app.catalog.refreshSessions();
          }}
          onClose={onClose}
        />
      )
    ) : null;
  return { commands, dialogs };
}
