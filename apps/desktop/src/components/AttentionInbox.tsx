import { Bell, Check, Clock } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
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
import { Dialog } from "./ui/Dialog";
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

function snapshot(): AttentionItemsResult { return getAttentionItems({ limit: 100 }); }
function summarySnapshot(): AttentionSummary { return getSummary(); }

function clipped(value: string, length = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length)}…` : compact;
}

export function AttentionInbox({ app, onOpenLocalItem }: AttentionInboxProps) {
  const desktop = useDesktopHost();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(snapshot);
  const [summary, setSummary] = useState(summarySnapshot);

  useEffect(() => subscribe(() => {
    setResult(snapshot());
    setSummary(summarySnapshot());
  }), []);

  const openItem = (item: AttentionItem) => {
    if (item.host === null && !item.targetDeviceId && onOpenLocalItem) {
      if (onOpenLocalItem(item)) { markRead(item.id); setOpen(false); }
      return;
    }
    const changed = markRead(item.id);
    if (!changed.ok) {
      setResult(snapshot());
      setSummary(summarySnapshot());
      return;
    }
    setOpen(false);
    const target = { host: item.host, sessionId: item.sessionId, ...(item.targetDeviceId ? { targetDeviceId: item.targetDeviceId } : {}) };
    if (desktop) desktop.openSession(target);
    else void app.actions.openSession(item.sessionId);
  };

  const snoozeItem = (event: MouseEvent, item: AttentionItem) => {
    event.stopPropagation();
    snooze(item.id, Date.now() + 60 * 60 * 1000);
    setResult(snapshot());
    setSummary(summarySnapshot());
  };

  return (
    <>
      <div className="attention-inbox-anchor">
        <button
          type="button"
          className="statusbar-icon-button attention-inbox-trigger"
          aria-label="打开提醒收件箱"
          title="提醒"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <Bell size={16} />
          {summary.unread > 0 && <span className="attention-inbox-badge" aria-label={`${summary.unread} 条未读提醒`}>{summary.unread > 99 ? "99+" : summary.unread}</span>}
        </button>
      </div>
      <Dialog
        open={open}
        title="提醒"
        description="完成、失败和需要你处理的会话会保留在这里。审批和问题只会打开会话。"
        onClose={() => setOpen(false)}
        className="attention-inbox-dialog"
      >
        {result.error && <p className="attention-inbox-error" role="status">{result.error}</p>}
        {result.items.length === 0 ? (
          <p className="attention-inbox-empty">暂无提醒</p>
        ) : (
          <div className="attention-inbox-list" aria-label="提醒列表">
            {result.items.map((item) => (
              <div key={item.id} className={`attention-inbox-item ${item.state}`}>
                <button type="button" className="attention-inbox-item-open" onClick={() => openItem(item)}>
                  <span className="attention-inbox-item-heading">
                    <strong>{clipped(item.title, 100) || "未命名会话"}</strong>
                    <span className={`attention-inbox-kind ${item.kind}`}>{kindLabel[item.kind]}</span>
                  </span>
                  <span className="attention-inbox-detail">{clipped(item.detail)}</span>
                  {(item.kind === "approval" || item.kind === "question") && (
                    <span className="attention-inbox-safe-note">打开会话后处理</span>
                  )}
                </button>
                <div className="attention-inbox-item-actions">
                  {item.state === "unread" && <button type="button" className="ghost" onClick={() => { markRead(item.id); setResult(snapshot()); setSummary(summarySnapshot()); }} title="标为已读" aria-label="标为已读"><Check size={14} /></button>}
                  {item.state !== "snoozed" && <button type="button" className="ghost" onClick={(event) => snoozeItem(event, item)} title="稍后提醒" aria-label="稍后提醒"><Clock size={14} /></button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </>
  );
}
