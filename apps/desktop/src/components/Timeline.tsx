import { ArrowDown, Download, FileText, FolderOpen, Search, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Artifact,
  Message,
  PlanTask,
  Question,
  QueuedMessage,
  ToolCall,
  TurnProgress,
} from "../types";
import type { PendingApproval } from "../App";
import {
  resolveWorkspacePath,
  revealLocalFile,
  type LocalFileTarget,
} from "../localFiles";
import { Md } from "./Md";
import { ExecutionPrelude, PlanProgress } from "./ExecutionActivity";
import { createTimelineItems, groupTimeline, filterTimelineGroups, type TimelineFilter, type TimelineGroup } from "../timelineModel";
import { downloadSession } from "../sessionExport";
import { CopyButton } from "./CopyButton";
import { ToolGroup } from "./ToolGroup";

function ApprovalCard({
  item,
  onResolve,
}: {
  item: PendingApproval;
  onResolve: (approvalId: string, decision: string) => void;
}) {
  return (
    <div className="card approval-card">
      <div className="card-head">
        <span>需要审批</span>
        <span className="tool-name">{item.toolName}</span>
        <span className={`badge ${item.approval.riskLevel}`}>
          {item.approval.riskLevel}
        </span>
      </div>
      <div style={{ marginTop: 6 }}>{item.approval.reason}</div>
      <pre>{JSON.stringify(item.input, null, 2)}</pre>
      <div className="approval-actions">
        <button onClick={() => onResolve(item.approval.id, "approve")}>允许一次</button>
        <button
          className="secondary"
          onClick={() => onResolve(item.approval.id, "approve_for_session")}
        >
          本会话允许
        </button>
        <button className="danger" onClick={() => onResolve(item.approval.id, "reject")}>
          拒绝
        </button>
      </div>
    </div>
  );
}

function QuestionCard({
  question,
  onResolve,
}: {
  question: Question;
  onResolve: (questionId: string, answer: string) => void;
}) {
  const [custom, setCustom] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!question.autoContinueAfterSeconds) {
      setRemainingSeconds(null);
      return;
    }
    const deadline =
      new Date(question.createdAt).getTime() + question.autoContinueAfterSeconds * 1_000;
    const update = () =>
      setRemainingSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [question.autoContinueAfterSeconds, question.createdAt]);

  useEffect(() => {
    setCustom("");
    setSelected([]);
  }, [question.id]);

  const countdown =
    remainingSeconds === null
      ? null
      : `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;
  return (
    <div className="card approval-card">
      <div className="card-head">
        <span>{question.header || "miniQ 想确认"}</span>
      </div>
      <div style={{ marginTop: 6 }}>{question.prompt}</div>
      {countdown && (
        <div className="question-timeout">
          完全访问模式: {countdown} 后将采用
          {question.defaultAnswer ? `“${question.defaultAnswer}”` : "默认方案"}继续
        </div>
      )}
      <div className="approval-actions" style={{ flexWrap: "wrap" }}>
        {question.options.map((opt) => {
          const active = selected.includes(opt);
          return (
            <button
              key={opt}
              className={active ? "question-option-selected" : undefined}
              aria-pressed={question.multiSelect ? active : undefined}
              title={question.optionDescriptions?.[opt]}
              onClick={() => {
                if (!question.multiSelect) {
                  onResolve(question.id, opt);
                  return;
                }
                setSelected((current) =>
                  current.includes(opt)
                    ? current.filter((value) => value !== opt)
                    : [...current, opt],
                );
              }}
            >
              <span>{opt}</span>
              {question.optionDescriptions?.[opt] && (
                <small>{question.optionDescriptions[opt]}</small>
              )}
            </button>
          );
        })}
        {question.multiSelect && (
          <button
            className="secondary"
            disabled={selected.length === 0}
            onClick={() => onResolve(question.id, selected.join(", "))}
          >
            确认选择
          </button>
        )}
      </div>
      <div className="approval-actions">
        <input
          className="question-input"
          value={custom}
          placeholder="或者输入你的回答..."
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && custom.trim()) {
              onResolve(question.id, custom.trim());
            }
          }}
        />
        <button
          className="secondary"
          disabled={!custom.trim()}
          onClick={() => onResolve(question.id, custom.trim())}
        >
          回答
        </button>
      </div>
    </div>
  );
}

function QueueBar(props: {
  queue: QueuedMessage[];
  onSteer: (queuedMessageId: string) => void;
  onRemove: (queuedMessageId: string) => void;
}) {
  if (props.queue.length === 0) return null;
  return (
    <div className="queue-bar">
      <div className="queue-title">已排队 {props.queue.length} 条，当前任务结束后依次执行</div>
      {props.queue.map((item) => (
        <div key={item.id} className="queue-item">
          <span className="queue-content" title={item.content}>
            {item.content}
          </span>
          <button
            className="ghost queue-steer"
            title="调整方向：打断当前任务，立即执行这条消息"
            onClick={() => props.onSteer(item.id)}
          >
            <Zap size={13} /> 调整方向
          </button>
          <button
            className="ghost queue-remove"
            title="从队列移除"
            onClick={() => props.onRemove(item.id)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ArtifactsBar(props: {
  artifacts: Artifact[];
  workspacePath?: string | null;
  onOpenFile: (target: LocalFileTarget) => void;
  onError: (message: string) => void;
}) {
  const { artifacts, workspacePath, onOpenFile, onError } = props;
  if (artifacts.length === 0) return null;
  return (
    <div className="artifacts-bar">
      <div className="plan-progress">交付产物</div>
      {artifacts.map((artifact) => {
        const path = resolveWorkspacePath(artifact.path, workspacePath);
        return (
          <div key={artifact.id} className="artifact-item" title={path ?? artifact.path}>
            <FileText size={18} aria-hidden="true" />
            <button
              type="button"
              className="artifact-open"
              disabled={!path}
              onClick={() => {
                if (path) onOpenFile({ path, line: null, column: null });
              }}
            >
              <span className="artifact-title">{artifact.title}</span>
              <span className="sub">{artifact.path}</span>
            </button>
            <span className="badge">{artifact.kind}</span>
            <button
              type="button"
              className="icon-button"
              aria-label={`在文件夹中显示 ${artifact.title}`}
              title="在文件夹中显示"
              disabled={!path}
              onClick={() => {
                if (path) void revealLocalFile(path, workspacePath).catch((cause) => {
                  onError(`无法在文件夹中显示：${cause instanceof Error ? cause.message : String(cause)}`);
                });
              }}
            >
              <FolderOpen size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface TimelineProps {
  title?: string;
  messages: Message[];
  toolCalls: ToolCall[];
  approvals: PendingApproval[];
  questions: Question[];
  plan: PlanTask[];
  artifacts: Artifact[];
  queue: QueuedMessage[];
  workspacePath?: string | null;
  streamingText: string;
  turnProgress: TurnProgress | null;
  busy: boolean;
  onResolveApproval: (approvalId: string, decision: string) => void;
  onResolveQuestion: (questionId: string, answer: string) => void;
  onRollback: (checkpointId: string) => void;
  onOpenFile: (target: LocalFileTarget) => void;
  onOpenUrl: (url: string) => void;
  onSteerQueued: (queuedMessageId: string) => void;
  onRemoveQueued: (queuedMessageId: string) => void;
  onError: (message: string) => void;
}

function TimelineEntries(props: {
  items: TimelineGroup[];
  expandGroups: boolean;
  onError: TimelineProps["onError"];
  approvals: PendingApproval[];
  questions: Question[];
  plan: PlanTask[];
  streamingText: string;
  turnProgress: TurnProgress | null;
  thinking: boolean;
  onResolveApproval: TimelineProps["onResolveApproval"];
  onResolveQuestion: TimelineProps["onResolveQuestion"];
  onRollback: TimelineProps["onRollback"];
  onOpenFile: TimelineProps["onOpenFile"];
  onOpenUrl: TimelineProps["onOpenUrl"];
  workspacePath?: string | null;
}) {
  return (
    <div className="timeline-inner">
      {props.items.map((item) =>
        item.kind === "message" ? (
          item.message.role === "user" ? (
            <div key={item.message.id} className="bubble user" title={new Date(item.message.createdAt).toLocaleString()}>
              {item.message.content}
              <CopyButton className="msg-copy" label="复制消息" content={item.message.content} onError={props.onError} />
            </div>
          ) : item.message.role === "tool" ? (
            <div key={item.message.id} className="bubble tool-transcript">
              <span>工具记录</span>
              <Md workspacePath={props.workspacePath} onOpenFile={props.onOpenFile} onOpenUrl={props.onOpenUrl}>
                {item.message.content}
              </Md>
            </div>
          ) : (
            <div key={item.message.id} className="bubble assistant" title={new Date(item.message.createdAt).toLocaleString()}>
              <Md workspacePath={props.workspacePath} onOpenFile={props.onOpenFile} onOpenUrl={props.onOpenUrl}>
                {item.message.content}
              </Md>
              <CopyButton className="msg-copy" label="复制消息" content={item.message.content} onError={props.onError} />
            </div>
          )
        ) : (
          <ToolGroup key={item.calls[0].id} calls={item.calls} onRollback={props.onRollback} expanded={props.expandGroups} />
        ),
      )}
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
        />
      ))}
      {props.streamingText && (
        <div className="bubble assistant">
          <Md workspacePath={props.workspacePath} onOpenFile={props.onOpenFile} onOpenUrl={props.onOpenUrl}>
            {props.streamingText}
          </Md>
          <span className="type-cursor" />
        </div>
      )}
      {props.thinking && (
        <ExecutionPrelude plan={props.plan} progress={props.turnProgress} />
      )}
      <PlanProgress plan={props.plan} />
    </div>
  );
}

export function Timeline(props: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [query, setQuery] = useState("");

  // Track whether the user is reading history (not pinned to bottom).
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    pinnedToBottom.current = nearBottom;
    setShowJump(!nearBottom);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    pinnedToBottom.current = true;
    setShowJump(false);
  };

  // Auto-follow only while pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [
    props.messages,
    props.toolCalls,
    props.approvals,
    props.questions,
    props.plan,
    props.streamingText,
    props.turnProgress,
    props.busy,
    props.queue,
  ]);

  const groups = useMemo(() => groupTimeline(createTimelineItems(props.messages, props.toolCalls)), [props.messages, props.toolCalls]);
  const items = useMemo(() => filterTimelineGroups(groups, filter, query), [groups, filter, query]);
  const hasRunningTool = props.toolCalls.some(
    (t) => t.status === "running" || t.status === "waiting_approval",
  );
  const thinking =
    props.busy &&
    !hasRunningTool &&
    props.approvals.length === 0 &&
    props.questions.length === 0;

  return (
    <>
      <div className="timeline-toolbar" aria-label="会话记录工具栏">
        <div className="timeline-modes" role="group" aria-label="记录类型">
          {([["all", "全部"], ["answers", "回答"], ["activity", "执行"], ["errors", "异常"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <label className="timeline-search"><Search size={14} /><input type="search" aria-label="搜索当前会话" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <details className="session-export"><summary title="导出会话" aria-label="导出会话"><Download size={16} /></summary><div>{(["md", "json"] as const).map((format) => <button type="button" key={format} onClick={() => {
          try { downloadSession({ title: props.title ?? "miniQ session", messages: props.messages, toolCalls: props.toolCalls, plan: props.plan, artifacts: props.artifacts }, format); }
          catch (cause) { props.onError(`导出失败: ${String(cause)}`); }
        }}>{format === "md" ? "Markdown" : "JSON"}</button>)}</div></details>
      </div>
      <div className="timeline" ref={scrollRef} onScroll={onScroll}>
        {items.length === 0 && (filter !== "all" || query) && <div className="diff-empty" role="status">没有匹配的记录</div>}
        <TimelineEntries
          items={items}
          expandGroups={filter !== "all" || !!query}
          onError={props.onError}
          approvals={props.approvals}
          questions={props.questions}
          plan={props.plan}
          streamingText={props.streamingText}
          turnProgress={props.turnProgress}
          thinking={thinking}
          onResolveApproval={props.onResolveApproval}
          onResolveQuestion={props.onResolveQuestion}
          onRollback={props.onRollback}
          onOpenFile={props.onOpenFile}
          onOpenUrl={props.onOpenUrl}
          workspacePath={props.workspacePath}
        />
        <QueueBar
          queue={props.queue}
          onSteer={props.onSteerQueued}
          onRemove={props.onRemoveQueued}
        />
      </div>
      {showJump && (
        <button
          type="button"
          className="jump-to-bottom"
          title="回到底部"
          aria-label="回到底部"
          onClick={jumpToBottom}
        >
          <ArrowDown size={15} />
        </button>
      )}
      <ArtifactsBar
        artifacts={props.artifacts}
        workspacePath={props.workspacePath}
        onOpenFile={props.onOpenFile}
        onError={props.onError}
      />
    </>
  );
}
