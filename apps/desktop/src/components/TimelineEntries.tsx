import { Check, LoaderCircle, Pencil, RefreshCw, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { AnchoredTurnTiming, Message, MessageAttachment, PlanTask, Question, TurnProgress } from "../types";
import type { PendingApproval } from "../App";
import type { RpcClient } from "../rpc";
import { readImagePreview } from "../localFiles";
import type { TimelineGroup } from "../timelineModel";
import type { TimelineProps } from "./Timeline";
import { ApprovalCard, ArtifactCard } from "./TimelineInteractions";
import { QuestionCard } from "./QuestionCard";
import { Md } from "./Md";
import { ExecutionPrelude, PlanProgress } from "./ExecutionActivity";
import { CopyButton } from "./CopyButton";
import { ToolGroup } from "./ToolGroup";
import { MessageTime, ConversationTimeSeparator } from "./MessageTime";
import { showConversationTimestamp } from "../time";
import { timelineGroupKey, timelineTurnEnds } from "../timelineTiming";
import { TurnTimingSummary } from "./TurnTimingSummary";
import { useSessionFileAccess } from "../sessionFileAccess";

function MessageAttachmentPreview({
  attachment,
}: {
  attachment: MessageAttachment;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const access = useSessionFileAccess();
  const isImage = Boolean(attachment.mimeType?.startsWith("image/"));

  useEffect(() => {
    if (!isImage) return;
    let disposed = false;
    const controller = new AbortController();
    void readImagePreview(attachment.path, { ...access, signal: controller.signal })
      .then((preview) => {
        if (!disposed)
          setImageUrl(`data:${preview.mimeType};base64,${preview.dataBase64}`);
      })
      .catch(() => {
        if (!disposed) setImageUrl(null);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [attachment.path, isImage, access]);

  if (imageUrl) {
    return (
      <img
        className="message-attachment-image"
        src={imageUrl}
        alt={attachment.name}
      />
    );
  }
  return <span className="message-attachment-file">{attachment.name}</span>;
}

export function TimelineEntries(props: {
  client?: RpcClient;
  items: TimelineGroup[];
  messages: Message[];
  expandGroups: boolean;
  onError: TimelineProps["onError"];
  approvals: PendingApproval[];
  questions: Question[];
  plan: PlanTask[];
  streamingText: string;
  turnProgress: TurnProgress | null;
  latestTurnTiming?: AnchoredTurnTiming | null;
  thinking: boolean;
  busy: boolean;
  onResolveApproval: TimelineProps["onResolveApproval"];
  onResolveQuestion: TimelineProps["onResolveQuestion"];
  onRollback: TimelineProps["onRollback"];
  onOpenFile: TimelineProps["onOpenFile"];
  onOpenUrl: TimelineProps["onOpenUrl"];
  onRewrite: TimelineProps["onRewrite"];
  workspacePath?: string | null;
  workspacePaths?: readonly string[];
}) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const turnEnds = useMemo(() => props.expandGroups ? new Map() : timelineTurnEnds(props.items, props.latestTurnTiming),
    [props.items, props.latestTurnTiming, props.expandGroups]);

  const startEditing = (message: Message) => {
    if (props.busy) return;
    setEditingMessageId(message.id);
    setDraft(message.content);
  };
  const cancelEditing = () => {
    setEditingMessageId(null);
    setDraft("");
  };
  const saveMessage = async (message: Message) => {
    const content = draft.trim();
    if (!content || saving || props.busy) return;
    setSaving(true);
    try {
      const sent = await props.onRewrite(
        message.id,
        content,
        message.attachments?.map((attachment) => attachment.path),
      );
      if (sent) cancelEditing();
    } catch (cause) {
      props.onError(`重新发送消息失败: ${String(cause)}`);
    } finally {
      setSaving(false);
    }
  };
  const regenerateMessage = async (message: Message) => {
    const messageIndex = props.messages.findIndex(
      (candidate) => candidate.id === message.id,
    );
    let userMessage: Message | undefined;
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      if (props.messages[index].role === "user") {
        userMessage = props.messages[index];
        break;
      }
    }
    if (!userMessage) {
      props.onError("找不到这条回复对应的用户消息");
      return;
    }
    try {
      await props.onRewrite(
        userMessage.id,
        userMessage.content,
        userMessage.attachments?.map((attachment) => attachment.path),
      );
    } catch (cause) {
      props.onError(`重新生成回复失败: ${String(cause)}`);
    }
  };

  return (
    <div className="timeline-inner">
      {props.items.map((item, index) => <Fragment key={timelineGroupKey(item)}>
        {item.kind === "message" && showConversationTimestamp(item.at, props.items[index - 1]?.at)
          && <ConversationTimeSeparator at={item.at} />}
        {
        item.kind === "message" ? (
          item.message.role === "user" ? (
            <div
              key={item.message.id}
              className="bubble user"
              data-user-message-id={item.message.id}
              data-history-anchor={`message:${item.message.id}`}
            >
              {editingMessageId === item.message.id ? (
                <textarea
                  className="message-edit-input"
                  aria-label="修改消息内容"
                  value={draft}
                  autoFocus
                  rows={Math.max(2, draft.split("\n").length)}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") cancelEditing();
                    if (
                      event.key === "Enter" &&
                      (event.ctrlKey || event.metaKey)
                    )
                      void saveMessage(item.message);
                  }}
                />
              ) : item.message.content ? (
                <div>{item.message.content}</div>
              ) : null}
              {item.message.attachments &&
                item.message.attachments.length > 0 && (
                  <div className="message-attachments">
                    {item.message.attachments.map((attachment) => (
                      <MessageAttachmentPreview
                        key={attachment.path}
                        attachment={attachment}
                      />
                    ))}
                  </div>
                )}
              <MessageTime at={item.message.createdAt} />
              <div className="message-actions">
                {editingMessageId === item.message.id ? (
                  <>
                    <button
                      type="button"
                      className="msg-action"
                      title="发送修改"
                      aria-label="发送修改"
                      disabled={!draft.trim() || saving || props.busy}
                      onClick={() => void saveMessage(item.message)}
                    >
                      {saving ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <Check size={15} />
                      )}
                    </button>
                    <button
                      type="button"
                      className="msg-action"
                      title="取消修改"
                      aria-label="取消修改"
                      onClick={cancelEditing}
                    >
                      <X size={15} />
                    </button>
                  </>
                ) : (
                  <>
                    <CopyButton
                      className="msg-copy"
                      label="复制消息"
                      content={item.message.content}
                      onError={props.onError}
                    />
                    <button
                      type="button"
                      className="msg-action"
                      title="修改消息"
                      aria-label="修改消息"
                      disabled={props.busy}
                      onClick={() => startEditing(item.message)}
                    >
                      <Pencil size={15} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : item.message.role === "tool" ? (
            <div
              key={item.message.id}
              className="bubble tool-transcript"
              data-history-anchor={`message:${item.message.id}`}
            >
              <span>工具记录</span>
              <Md
                workspacePath={props.workspacePath}
                onOpenFile={props.onOpenFile}
                onOpenUrl={props.onOpenUrl}
              >
                {item.message.content}
              </Md>
            </div>
          ) : (
            <div
              key={item.message.id}
              className="bubble assistant"
              data-history-anchor={`message:${item.message.id}`}
            >
              <Md
                workspacePath={props.workspacePath}
                onOpenFile={props.onOpenFile}
                onOpenUrl={props.onOpenUrl}
              >
                {item.message.content}
              </Md>
              <MessageTime at={item.message.createdAt} />
              <div className="message-actions assistant-actions">
                <CopyButton
                  className="msg-copy"
                  label="复制消息"
                  content={item.message.content}
                  onError={props.onError}
                />
                <button
                  type="button"
                  className="msg-action"
                  title="重新生成"
                  aria-label="重新生成"
                  disabled={props.busy}
                  onClick={() => void regenerateMessage(item.message)}
                >
                  <RefreshCw size={15} />
                </button>
              </div>
            </div>
          )
        ) : item.kind === "artifact" ? (
          <div
            key={item.artifact.id}
            data-history-anchor={`artifact:${item.artifact.id}`}
          >
            <ArtifactCard
              artifact={item.artifact}
              workspacePath={props.workspacePath}
              workspacePaths={props.workspacePaths}
              onOpenFile={props.onOpenFile}
              onError={props.onError}
            />
          </div>
        ) : (
          <div
            key={item.calls[0].id}
            data-history-anchor={`tool:${item.calls[0].id}`}
          >
            <ToolGroup
              calls={item.calls}
              onRollback={props.onRollback}
              expanded={props.expandGroups}
              client={props.client}
            />
          </div>
        )}
        {turnEnds.has(timelineGroupKey(item)) && <TurnTimingSummary timing={turnEnds.get(timelineGroupKey(item))!} />}
      </Fragment>)}
      {props.approvals.map((approval) => (
        <ApprovalCard
          key={approval.approval.id}
          item={approval}
          onResolve={props.onResolveApproval}
        />
      ))}
      {props.questions.map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          onResolve={props.onResolveQuestion}
          workspacePath={props.workspacePath}
          onOpenFile={props.onOpenFile}
          onOpenUrl={props.onOpenUrl}
        />
      ))}
      {props.streamingText && (
        <div className="bubble assistant">
          <Md
            workspacePath={props.workspacePath}
            onOpenFile={props.onOpenFile}
            onOpenUrl={props.onOpenUrl}
          >
            {props.streamingText}
          </Md>
          <span className="type-cursor" />
        </div>
      )}
      {props.thinking && (
        <ExecutionPrelude plan={props.plan} progress={props.turnProgress} />
      )}
      <PlanProgress plan={props.plan} busy={props.busy} />
    </div>
  );
}
