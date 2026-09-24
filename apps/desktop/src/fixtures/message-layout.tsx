import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TimelineEntries } from "../components/TimelineEntries";
import { MobileChatRow } from "../components/MobileChatRow";
import type { Message } from "../types";
import type { MobileChatMessage } from "../mobileChatData";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/remote.css";
import "../styles/experience.css";
import "../styles/mobile-controls.css";

// Local fixture: no daemon, provider, disk reads, or persisted conversations.
const today = new Date();
today.setHours(18, 2, 0, 0);
const yesterday = new Date(today);
yesterday.setDate(yesterday.getDate() - 1);
const lastYear = new Date(today.getFullYear() - 1, 11, 31, 18, 2);
const noop = () => undefined;
const message = (id: string, role: Message["role"], content: string, at = today): Message => ({
  id, sessionId: "message-layout", role, content, createdAt: at.toISOString(),
});
const initialMessages: Message[] = [
  message("hello", "user", "hello"),
  message("short-answer", "assistant", "好。"),
  message("single-character", "user", "好"),
  message("emoji", "user", "🙂"),
  { ...message("attachment", "user", ""), attachments: [{ path: "/fixture/a.txt", name: "a.txt", mimeType: "text/plain" }] },
  message("yesterday", "user", "昨天", yesterday),
  message("last-year", "user", "跨年", lastYear),
  message("last-year-answer", "assistant", "好。", lastYear),
  message("unbroken", "user", "abcdefghijklmnopqrstuvwxyz0123456789".repeat(8)),
  message("multiline", "user", "第一行\n\n第三行保留空行。\n第四行。"),
];
const initialMobileMessages: MobileChatMessage[] = [
  { id: "mobile-hello", role: "user", content: "hello", createdAt: today.toISOString() },
  { id: "mobile-answer", role: "assistant", content: "好。", createdAt: lastYear.toISOString(), elapsedMs: 172_801_000 },
  { id: "mobile-yesterday", role: "user", content: "🙂", createdAt: yesterday.toISOString() },
];

function Fixture() {
  const [width, setWidth] = useState(1280);
  const [mobileWidth, setMobileWidth] = useState(320);
  const [messages, setMessages] = useState(initialMessages);
  const [mobileMessages, setMobileMessages] = useState(initialMobileMessages);
  const [status, setStatus] = useState("点击时间展开详情；可直接编辑、取消或保存消息。");
  return <>
    <style>{`
      html, body { overflow: auto; }
      .layout-preview { width: min(100%, 1280px); margin: 0 auto; background: var(--bg); }
      .layout-preview-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; }
      .layout-preview-controls button { min-height: 36px; }
      .layout-preview-controls button[aria-pressed="true"] { outline: 2px solid var(--accent); }
      .layout-preview-status { margin: 0; padding: 0 12px 12px; color: var(--text-mid); }
      .layout-preview h2 { margin: 0; padding: 12px; font-size: 15px; }
      .layout-preview-mobile { max-width: 100%; padding: 12px; margin: 0 auto; }
    `}</style>
    <main className="layout-preview" style={{ width: `min(100%, ${width}px)` }}>
      <header className="layout-preview-controls">
        <strong>消息布局验收</strong>
        {[320, 390, 1280].map((value) => <button key={value} aria-pressed={width === value} onClick={() => setWidth(value)}>{value}px</button>)}
        <button onClick={() => { setMessages(initialMessages); setMobileMessages(initialMobileMessages); }}>重置消息</button>
      </header>
      <p className="layout-preview-status" role="status">{status}</p>
      <h2>桌面与远程会话</h2>
      <section className="timeline" aria-label="桌面消息布局">
        <TimelineEntries items={messages.map((entry) => ({ kind: "message", at: entry.createdAt, message: entry }))}
          messages={messages} expandGroups={false} approvals={[]} questions={[]} plan={[]}
          streamingText="" turnProgress={null} thinking={false} busy={false}
          onResolveApproval={noop} onResolveQuestion={noop} onRollback={noop} onOpenFile={noop} onOpenUrl={noop}
          onError={setStatus} onFork={async (id) => { setStatus(`已点击分支：${id}`); return true; }}
          onRewrite={async (id, content) => {
            setMessages((current) => current.map((entry) => entry.id === id ? { ...entry, content } : entry));
            setStatus(`已保存：${id}`);
            return true;
          }} />
      </section>
      <h2>移动独立问答</h2>
      <div className="layout-preview-controls">
        {[240, 320, 390].map((value) => <button key={value} aria-pressed={mobileWidth === value} onClick={() => setMobileWidth(value)}>移动 {value}px</button>)}
      </div>
      <section className="layout-preview-mobile" aria-label="移动消息布局" style={{ width: mobileWidth }}>
        {mobileMessages.map((entry) => <MobileChatRow key={entry.id} message={entry} active={false}
          onDelete={(id) => setMobileMessages((current) => current.filter((item) => item.id !== id))} />)}
      </section>
    </main>
  </>;
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Fixture />);
