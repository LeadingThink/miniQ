import { Check, GitBranch, LoaderCircle, Pencil, RefreshCw, Target, X } from "lucide-react";
import { Fragment, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react";
import type { AnchoredTurnTiming, Message, Question, SessionGoal, TurnPlan } from "../types";
import type { PendingApproval } from "../App";
import type { RpcClient } from "../rpc";
import type { TimelineGroup } from "../timelineModel";
import type { TimelineProps } from "./Timeline";
import { ApprovalCard, ArtifactCard } from "./TimelineInteractions";
import { QuestionCard } from "./QuestionCard";
import { Md } from "./Md";
import { TurnPlanSummary } from "./ExecutionActivity";
import { CopyButton } from "./CopyButton";
import { SpeakButton } from "./SpeakButton";
import { useVoiceCapabilities } from "../voiceCapabilities";
import { ToolGroup } from "./ToolGroup";
import { MessageTime, ConversationTimeSeparator } from "./MessageTime";
import { timelineGroupKey, timelineTurnPlanEnds } from "../timelineTiming";
import {
  groupTimelineTurns, searchRecordKeys, turnSeparators, turnSegments, type TurnSegment,
} from "../timelineTurns";
import { WINDOW_MIN_TURNS } from "../timelineWindow";
import { useTurnWindow } from "../hooks/useTurnWindow";
import { ExecutionFold } from "./ExecutionFold";
import { MessageAttachmentPreview } from "./MessageAttachmentPreview";
import { TimelineTurnFrame } from "./TimelineTurnFrame";
import { TurnChangesCard } from "./TurnChangesCard";
import { turnHasFileWrites } from "../turnChanges";
import { ConfirmDialog } from "./ui/Dialog";

/** An edit or regenerate that waits for the user to confirm stopping the run. */
interface PendingRewrite {
  kind: "edit" | "regenerate";
  message: Message;
  content: string;
}

/** Lets the conversation mount a windowed-out turn before revealing a record. */
export interface TimelineWindowHandle {
  /** Returns true when the record's turn was not mounted; it is after the next commit. */
  mountRecord: (recordKey: string) => boolean;
}

export function findGoalMessageId(
  messages: Message[],
  goal?: SessionGoal | null,
): string | null {
  if (!goal) return null;
  return [...messages].reverse().find(
    (message) =>
      message.role === "user" && message.content.trim() === goal.goal.trim(),
  )?.id ?? null;
}

export function TimelineEntries(props: {
  client?: RpcClient;
  items: TimelineGroup[];
  messages: Message[];
  goal?: SessionGoal | null;
  expandGroups: boolean;
  onError: TimelineProps["onError"];
  approvals: PendingApproval[];
  questions: Question[];
  turnPlans?: TurnPlan[];
  streamingText: string;
  latestTurnTiming?: AnchoredTurnTiming | null;
  busy: boolean;
  onResolveApproval: TimelineProps["onResolveApproval"];
  onResolveQuestion: TimelineProps["onResolveQuestion"];
  onRollback: TimelineProps["onRollback"];
  onOpenFile: TimelineProps["onOpenFile"];
  onOpenUrl: TimelineProps["onOpenUrl"];
  onRewrite: TimelineProps["onRewrite"];
  onFork?: TimelineProps["onFork"];
  onStopTurn?: TimelineProps["onStopTurn"];
  workspacePath?: string | null;
  workspacePaths?: readonly string[];
  /** The scrolling transcript; enables windowing of long conversations. */
  scrollRef?: RefObject<HTMLDivElement | null>;
  windowHandle?: RefObject<TimelineWindowHandle | null>;
}) {
  const [pendingRewrite, setPendingRewrite] = useState<PendingRewrite | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const voiceCapabilities = useVoiceCapabilities(props.client);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const turnPlanEnds = useMemo(() => timelineTurnPlanEnds(props.items, props.turnPlans ?? []),
    [props.items, props.turnPlans]);
  // The running turn's plan lives in the composer pill; it joins the timeline once the turn ends.
  const runningAnchor = props.busy
    ? [...props.messages].reverse().find((message) => message.role === "user")?.id
    : undefined;
  // Completed turns can be forked while a run is active. The backend copies
  // only durable history, so only replies in the running turn stay locked.
  const runningTurnMessageIds = useMemo(() => {
    if (!props.busy) return null;
    let start = props.messages.length - 1;
    while (start >= 0 && props.messages[start].role !== "user") start -= 1;
    return new Set(start < 0 ? [] : props.messages.slice(start).map((message) => message.id));
  }, [props.busy, props.messages]);
  const goalMessageId = useMemo(
    () => findGoalMessageId(props.messages, props.goal),
    [props.goal, props.messages],
  );

  const startEditing = (message: Message) => {
    setEditingMessageId(message.id);
    setDraft(message.content);
  };
  const cancelEditing = () => {
    setEditingMessageId(null);
    setDraft("");
  };
  // Rewriting while a turn runs first stops it; the daemon waits for the
  // stopped turn to release the session before replacing history.
  const rewrite = async ({ kind, message, content }: PendingRewrite, stopFirst: boolean) => {
    setSaving(true);
    try {
      if (stopFirst) await props.onStopTurn?.();
      const sent = await props.onRewrite(
        message.id,
        content,
        message.attachments?.map((attachment) => attachment.path),
      );
      if (sent && kind === "edit") cancelEditing();
    } catch (cause) {
      props.onError(`${kind === "edit" ? "重新发送消息" : "重新生成回复"}失败: ${String(cause)}`);
    } finally {
      setSaving(false);
    }
  };
  const requestRewrite = async (request: PendingRewrite) => {
    if (props.busy) setPendingRewrite(request);
    else await rewrite(request, false);
  };
  const saveMessage = async (message: Message) => {
    const content = draft.trim();
    if (!content || saving) return;
    await requestRewrite({ kind: "edit", message, content });
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
    await requestRewrite({ kind: "regenerate", message: userMessage, content: userMessage.content });
  };

  const live = useRef({
    props, startEditing, cancelEditing, saveMessage, regenerateMessage,
  });
  live.current = { props, startEditing, cancelEditing, saveMessage, regenerateMessage };
  const bridge = useMemo(() => ({
    openFile: (target: Parameters<NonNullable<TimelineProps["onOpenFile"]>>[0]) =>
      live.current.props.onOpenFile(target),
    openUrl: (url: string) => live.current.props.onOpenUrl(url),
    reportError: (message: string) => live.current.props.onError(message),
    rollback: ((...args: Parameters<TimelineProps["onRollback"]>) =>
      live.current.props.onRollback(...args)) as TimelineProps["onRollback"],
    startEditing: (message: Message) => live.current.startEditing(message),
    cancelEditing: () => live.current.cancelEditing(),
    saveMessage: (message: Message) => live.current.saveMessage(message),
    regenerateMessage: (message: Message) => live.current.regenerateMessage(message),
    fork: (messageId: string) => {
      setForkingMessageId(messageId);
      return Promise.resolve(live.current.props.onFork?.(messageId))
        .finally(() => setForkingMessageId(null));
    },
  }), []);
  const hasFork = Boolean(props.onFork);
  const canSpeak = voiceCapabilities.capabilities.speak;
  // Streaming tokens only change the live tail. Keeping each turn's content
  // element identity stable lets React skip every completed message on each
  // token instead of re-rendering the whole conversation.
  const turns = useMemo(() => groupTimelineTurns(props.items, props.latestTurnTiming),
    [props.items, props.latestTurnTiming]);
  const turnKeys = useMemo(() => turns.map((turn) => turn.key), [turns]);
  const separators = useMemo(() => turnSeparators(turns), [turns]);
  const listRef = useRef<HTMLDivElement>(null);
  const turnWindow = useTurnWindow({
    scrollRef: props.scrollRef,
    listRef,
    keys: turnKeys,
    // Search and filter results are short and stepped through element by element.
    enabled: !props.expandGroups && turns.length >= WINDOW_MIN_TURNS,
  });
  const windowState = useRef({ turns, turnWindow });
  windowState.current = { turns, turnWindow };
  useImperativeHandle(props.windowHandle, () => ({
    mountRecord: (recordKey: string) => {
      const { turns, turnWindow } = windowState.current;
      const index = turns.findIndex((turn) => searchRecordKeys(turn.groups).split(" ").includes(recordKey));
      if (index < 0 || turnWindow.isMounted(index)) return false;
      turnWindow.mount(turns[index].key);
      return true;
    },
  }), []);
  // Approvals and questions always render below history; open the latest turn's
  // execution so the step that asked is visible next to them.
  const pendingAttention = props.approvals.length > 0 || props.questions.length > 0;
  const turnContents = useMemo(() => {
    // The newest reply keeps its actions visible; older ones reveal on hover.
    let latestAssistantId: string | undefined;
    for (let index = props.items.length - 1; index >= 0; index -= 1) {
      const candidate = props.items[index];
      if (candidate.kind === "message" && candidate.message.role === "assistant") {
        latestAssistantId = candidate.message.id;
        break;
      }
    }
    const renderGroup = (item: TimelineGroup) => {
      return <Fragment key={timelineGroupKey(item)}>
        {
        item.kind === "message" ? (
          item.message.role === "user" ? (
            item.message.steered ? (
              <div
                key={item.message.id}
                className="steer-note"
                data-history-anchor={`message:${item.message.id}`}
              >
                <span className="steer-note-label">引导：</span>
                {item.message.content}
              </div>
            ) : <div
              key={item.message.id}
              className="message-entry user"
              data-user-message-id={item.message.id}
              data-history-anchor={`message:${item.message.id}`}
            >
              <div className="bubble user">
                {editingMessageId === item.message.id ? (
                  <textarea
                    className="message-edit-input"
                    aria-label="修改消息内容"
                    value={draft}
                    autoFocus
                    rows={Math.max(2, draft.split("\n").length)}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") bridge.cancelEditing();
                      if (
                        event.key === "Enter" &&
                        (event.ctrlKey || event.metaKey)
                      )
                        void bridge.saveMessage(item.message);
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
              </div>
              <div className="message-footer">
                <MessageTime at={item.message.createdAt} />
                <div className="message-actions">
                  {item.message.id === goalMessageId && (
                    <span className="message-goal-marker">
                      <Target size={13} aria-hidden="true" />
                      设为目标
                    </span>
                  )}
                  {editingMessageId === item.message.id ? (
                    <>
                      <button
                        type="button"
                        className="msg-action"
                        title="发送修改"
                        aria-label="发送修改"
                        disabled={!draft.trim() || saving}
                        onClick={() => void bridge.saveMessage(item.message)}
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
                        onClick={bridge.cancelEditing}
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
                        onError={bridge.reportError}
                      />
                      <button
                        type="button"
                        className="msg-action"
                        title="修改消息"
                        aria-label="修改消息"
                        onClick={() => bridge.startEditing(item.message)}
                      >
                        <Pencil size={15} />
                      </button>
                    </>
                  )}
                </div>
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
                onOpenFile={bridge.openFile}
                onOpenUrl={bridge.openUrl}
              >
                {item.message.content}
              </Md>
            </div>
          ) : (
            <div
              key={item.message.id}
              className={`message-entry assistant${item.message.id === latestAssistantId ? " is-latest" : ""}`}
              data-history-anchor={`message:${item.message.id}`}
            >
              <div className="bubble assistant">
                <Md
                  workspacePath={props.workspacePath}
                  onOpenFile={bridge.openFile}
                  onOpenUrl={bridge.openUrl}
                >
                  {item.message.content}
                </Md>
              </div>
              <div className="message-footer">
                <MessageTime at={item.message.createdAt} />
                <div className="message-actions">
                  <CopyButton
                    className="msg-copy"
                    label="复制消息"
                    content={item.message.content}
                    onError={bridge.reportError}
                  />
                  {props.client && canSpeak && (
                    <SpeakButton
                      client={props.client}
                      text={item.message.content}
                      disabled={props.busy}
                      onError={bridge.reportError}
                    />
                  )}
                  <button
                    type="button"
                    className="msg-action"
                    title="重新生成"
                    aria-label="重新生成"
                    disabled={saving || (props.busy && item.message.id !== latestAssistantId)}
                    onClick={() => void bridge.regenerateMessage(item.message)}
                  >
                    <RefreshCw size={15} />
                  </button>
                  {hasFork && (
                    <button
                      type="button"
                      className="msg-action"
                      title={runningTurnMessageIds?.has(item.message.id) ? "本轮完成后可分支" : "分支到新聊天"}
                      aria-label="分支到新聊天"
                      disabled={Boolean(runningTurnMessageIds?.has(item.message.id)) || forkingMessageId !== null}
                      onClick={() => {
                        void bridge.fork(item.message.id).finally(() => setForkingMessageId(null));
                      }}
                    >
                      {forkingMessageId === item.message.id ? <LoaderCircle className="spin" size={15} /> : <GitBranch size={15} />}
                    </button>
                  )}
                </div>
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
              onOpenFile={bridge.openFile}
              onError={bridge.reportError}
            />
          </div>
        ) : (
          <div
            key={item.calls[0].id}
            data-history-anchor={`tool:${item.calls[0].id}`}
            data-search-records={item.calls.map((call) => `tool:${call.id}`).join(" ")}
          >
            <ToolGroup
              calls={item.calls}
              onRollback={bridge.rollback}
              expanded={props.expandGroups}
              client={props.client}
            />
          </div>
        )}
      </Fragment>;
    };
    const lastTurn = turns.at(-1);
    return turns.map((turn) => {
      const endKey = timelineGroupKey(turn.groups[turn.groups.length - 1]);
      const turnPlan = turnPlanEnds.get(endKey);
      const planNode = turnPlan && turnPlan.anchorMessageId !== runningAnchor
        ? <TurnPlanSummary plan={turnPlan.tasks} /> : null;
      const segments: TurnSegment[] = props.expandGroups
        ? turn.groups.map((group) => ({ kind: "group", group }))
        : turnSegments(turn);
      const hasFold = segments.some((segment) => segment.kind === "execution");
      const isLast = turn === lastTurn;
      const separatorAt = props.expandGroups ? undefined : separators.get(turn.key);
      return <Fragment key={turn.key}>
        {separatorAt && <ConversationTimeSeparator at={separatorAt} />}
        {segments.map((segment) => segment.kind === "group" ? renderGroup(segment.group) : (
          <div key={segment.key} data-history-anchor={segment.key} data-search-records={searchRecordKeys(segment.groups)}>
            <ExecutionFold
              calls={segment.calls}
              timing={turn.timing}
              active={isLast && props.busy}
              attention={isLast && pendingAttention}
            >
              {segment.groups.map(renderGroup)}
              {planNode}
            </ExecutionFold>
          </div>
        ))}
        {/* Turn end: cards summarising the finished turn. */}
        {!hasFold && planNode}
        {turn.userMessageId && !(isLast && props.busy) && turnHasFileWrites(turn)
          && <TurnChangesCard turnId={turn.userMessageId} />}
      </Fragment>;
    });
  }, [
    props.items, props.busy, props.workspacePath, props.workspacePaths,
    props.expandGroups, props.client, editingMessageId, draft, saving,
    forkingMessageId, runningTurnMessageIds, goalMessageId, turnPlanEnds, runningAnchor,
    hasFork, canSpeak, bridge, turns, separators, pendingAttention,
  ]);

  // The live reply streams at the end of the current turn, where its message
  // lands when it is created, rather than below approval and question cards.
  const streaming = props.streamingText ? (
    <div className="message-entry assistant is-streaming">
      <div className="bubble assistant">
        <Md
          streaming
          workspacePath={props.workspacePath}
          onOpenFile={props.onOpenFile}
          onOpenUrl={props.onOpenUrl}
        >
          {props.streamingText}
        </Md>
      </div>
    </div>
  ) : null;
  return (
    <div className="timeline-inner" ref={listRef}>
      {turns.map((turn, index) => (
        <TimelineTurnFrame
          key={turn.key}
          turn={turn}
          mounted={turnWindow.isMounted(index)}
          placeholderHeight={turnWindow.placeholderHeight}
        >
          {turnContents[index]}
          {index === turns.length - 1 && streaming}
        </TimelineTurnFrame>
      ))}
      {turns.length === 0 && streaming}
      <ConfirmDialog
        open={pendingRewrite !== null}
        tone="danger"
        title={pendingRewrite?.kind === "regenerate" ? "停止当前任务并重新生成？" : "停止当前任务并发送修改？"}
        description="当前正在运行的任务会被停止，之后从这条消息重新开始。"
        confirmLabel="停止并继续"
        onCancel={() => setPendingRewrite(null)}
        onConfirm={() => {
          const request = pendingRewrite;
          setPendingRewrite(null);
          if (request) void rewrite(request, true);
        }}
      />
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
    </div>
  );
}
