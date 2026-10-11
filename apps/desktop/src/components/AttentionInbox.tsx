import { AlertTriangle, Bell, Check, CheckCircle2, Clock, MessageCircleQuestion, ShieldAlert, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { useDesktopHost } from "../desktopHost";
import {
  getAttentionItems,
  getSummary,
  markRead,
  snooze,
  subscribe,
  type AttentionItem,
  type AttentionItemsResult,
  type AttentionSummary,
} from "../companionInbox";
import { Popover } from "./ui/Popover";
import "./AttentionInbox.css";

interface AttentionInboxProps {
  app: MiniqAppController;
  onOpenLocalItem?: (item: AttentionItem) => boolean;
}

const kindLabel: Record<AttentionItem["kind"], string> = {
  completed: "已完成",
  failed: "失败",
  approval: "需要审批",
  question: "需要回答",
  reminder: "提醒",
};

const kindIcon: Record<AttentionItem["kind"], ReactNode> = {
  completed: <CheckCircle2 size={14} />,
  failed: <XCircle size={14} />,
  approval: <ShieldAlert size={14} />,
  question: <MessageCircleQuestion size={14} />,
  reminder: <Bell size={14} />,
};

function snapshot(): AttentionItemsResult { return getAttentionItems({ limit: 100 }); }
function summarySnapshot(): AttentionSummary { return getSummary(); }

function clipped(value: string, length = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length)}…` : compact;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

function startOfToday(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function AttentionInbox({ app, onOpenLocalItem }: AttentionInboxProps) {
  const desktop = useDesktopHost();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(snapshot);
  const [summary, setSummary] = useState(summarySnapshot);

  const refresh = useCallback(() => {
    setResult(snapshot());
    setSummary(summarySnapshot());
  }, []);

  useEffect(() => subscribe(refresh), [refresh]);
  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  const close = useCallback(() => setOpen(false), []);

  const openItem = (item: AttentionItem) => {
    if (item.host === null && !item.targetDeviceId && onOpenLocalItem) {
      if (onOpenLocalItem(item)) { markRead(item.id); setOpen(false); }
      refresh();
      return;
    }
    const changed = markRead(item.id);
    if (!changed.ok) { refresh(); return; }
    setOpen(false);
    const target = { host: item.host, sessionId: item.sessionId, ...(item.targetDeviceId ? { targetDeviceId: item.targetDeviceId } : {}) };
    if (desktop) desktop.openSession(target);
    else void app.actions.openSession(item.sessionId);
  };

  const markItemRead = (item: AttentionItem) => { markRead(item.id); refresh(); };
  const snoozeItem = (item: AttentionItem) => { snooze(item.id, Date.now() + 60 * 60 * 1000); refresh(); };
  const markAllRead = () => {
    for (const item of result.items) if (item.state === "unread") markRead(item.id);
    refresh();
  };

  const unread = summary.unread;
  const badge = unread > 99 ? "99+" : String(unread);
  const label = unread > 0 ? `提醒，${unread} 条未读` : "提醒";
  const today = startOfToday();
  const groups = [
    { key: "today", title: "今天", items: result.items.filter((item) => item.createdAt >= today) },
    { key: "earlier", title: "更早", items: result.items.filter((item) => !(item.createdAt >= today)) },
  ].filter((group) => group.items.length > 0);
  const showGroupTitles = groups.length > 1 || groups[0]?.key === "earlier";

  const renderItem = (item: AttentionItem) => {
    const needsSession = item.kind === "approval" || item.kind === "question";
    const title = clipped(item.title, 100) || "未命名会话";
    return (
      <li key={item.id} className={`attention-inbox-item ${item.state}`}>
        <button
          type="button"
          className="attention-inbox-item-open"
          onClick={() => openItem(item)}
          aria-label={`${title}，${kindLabel[item.kind]}${item.state === "unread" ? "，未读" : ""}`}
        >
          <span className={`attention-inbox-kind-icon ${item.kind}`} title={kindLabel[item.kind]} aria-hidden="true">{kindIcon[item.kind]}</span>
          <span className="attention-inbox-item-body">
            <span className="attention-inbox-item-line">
              <span className="attention-inbox-item-title">{title}</span>
              {item.state === "unread" && <span className="attention-inbox-unread-dot" aria-hidden="true" />}
              {needsSession && <span className="attention-inbox-pill">去会话处理</span>}
              <span className="attention-inbox-time">{relativeTime(item.createdAt)}</span>
            </span>
            {item.detail && <span className="attention-inbox-detail">{clipped(item.detail)}</span>}
          </span>
        </button>
        <span className="attention-inbox-item-actions">
          {item.state === "unread" && (
            <button type="button" className="ghost" onClick={() => markItemRead(item)} title="标为已读" aria-label="标为已读"><Check size={14} /></button>
          )}
          {item.state !== "snoozed" && (
            <button type="button" className="ghost" onClick={() => snoozeItem(item)} title="稍后 1 小时" aria-label="稍后 1 小时"><Clock size={14} /></button>
          )}
        </span>
      </li>
    );
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="statusbar-icon-button attention-inbox-trigger"
        data-tooltip="提醒"
        title="提醒"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={16} />
        {unread > 0 && <span className="attention-inbox-badge" aria-hidden="true">{badge}</span>}
      </button>
      <Popover open={open} anchorRef={anchor} onClose={close} label="提醒" className="attention-inbox-popover">
        <div className="attention-inbox-header">
          <span className="attention-inbox-heading">提醒</span>
          {unread > 0 && <span className="attention-inbox-count">{unread} 条未读</span>}
          <span className="attention-inbox-spacer" />
          {unread > 0 && (
            <button type="button" className="attention-inbox-text-button" onClick={markAllRead}>全部已读</button>
          )}
        </div>
        {result.error && (
          <p className="attention-inbox-error" role="status"><AlertTriangle size={13} aria-hidden="true" /> {result.error}</p>
        )}
        {result.items.length === 0 ? (
          <p className="attention-inbox-empty">任务完成、失败或需要你处理时会出现在这里</p>
        ) : (
          <div className="attention-inbox-list" aria-label="提醒列表">
            {groups.map((group) => (
              <section key={group.key} className="attention-inbox-group" aria-label={group.title}>
                {showGroupTitles && <h3 className="attention-inbox-group-title">{group.title}</h3>}
                <ul>{group.items.map(renderItem)}</ul>
              </section>
            ))}
          </div>
        )}
      </Popover>
    </>
  );
}
