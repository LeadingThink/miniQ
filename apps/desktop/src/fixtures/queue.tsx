import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerCard } from "../components/Composer";
import { QueueBar } from "../components/QueueBar";
import { SessionModelControls } from "../components/SessionModelControls";
import { SessionPermissionControls } from "../components/SessionPermissionControls";
import { useSessionModel } from "../hooks/useSessionModel";
import { DEFAULT_MODEL_SETTINGS } from "../modelSelection";
import type { RpcClient } from "../rpc";
import type { QueuedMessage } from "../types";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/pages.css";
import "../styles/experience.css";
import "../styles/mobile-controls.css";
import "../styles/hero.css";

const initial: QueuedMessage[] = [
  {
    id: "one", sessionId: "fixture", position: 1, createdAt: "2026-10-22",
    content: "为什么还会有这个问题，这个不是昨天修改过吗，你看一下输入框和按钮样式。",
    attachments: [{ path: "/fixture/image.png", name: "image.png" }],
  },
  {
    id: "two", sessionId: "fixture", position: 2, createdAt: "2026-10-22",
    content: "然后检查手机与桌面的布局，保留完整的消息内容和附件。".repeat(8),
    attachments: [{ path: "/fixture/需要审核的完整报告及补充材料.pdf", name: "需要审核的完整报告及补充材料.pdf" }],
  },
];
let approval = { mode: null, effective: "fullAccess" };
let settings = { ...DEFAULT_MODEL_SETTINGS, model: "deepseek-flash", reasoningEffort: "high" };
const client = {
  mode: "local", connected: true, onEvent: () => () => {}, onStatus: () => () => {},
  call: async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "voice.capabilities") return { transcribe: true, speak: false, transcribeModel: "fixture" };
    if (method === "model.list") return { models: ["deepseek-flash", "gpt-6.1-sol", "deepseek-v4-pro-long-model-name"] };
    if (method === "model.describe") return { reasoningEfforts: ["low", "medium", "high"], contextWindow: 128000 };
    if (method === "skill.list") return { skills: [] };
    if (method === "session.modelUpdate") settings = params.settings as typeof settings;
    if (method === "session.modelGet" || method === "session.modelUpdate") return { settings, effective: settings };
    if (method === "session.approval.update") approval = { mode: params.mode, effective: params.mode ?? "fullAccess" } as typeof approval;
    if (method === "session.approval.get" || method === "session.approval.update") return approval;
    throw new Error(`仅本地验收，不执行 ${method}`);
  },
} as unknown as RpcClient;

function Fixture() {
  const [queue, setQueue] = useState(initial.slice(0, 1));
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [dark, setDark] = useState(false);
  const model = useSessionModel(client, "fixture", "workspace");
  const updateContent = async (original: QueuedMessage, content: string) => {
    setQueue((items) => items.map((item) => item.id === original.id ? { ...item, content } : item));
    setNotice("已保存，附件与顺序保持不变");
  };
  return (
    <main style={{ width: "100%", maxWidth: 960, margin: "auto", padding: "40px 16px", boxSizing: "border-box" }}>
      <h1 style={{ fontSize: 20 }}>输入坞与排队任务验收</h1>
      <p style={{ color: "var(--text-mid)" }}>使用真实组件和本地模拟数据，不连接服务或执行任务。</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 24 }}>
        <button className="secondary" onClick={() => setQueue([])}>清空队列</button>
        <button className="secondary" onClick={() => setQueue(initial.slice(0, 1))}>单条排队</button>
        <button className="secondary" onClick={() => setQueue(initial)}>多条排队</button>
        <button className="secondary" aria-pressed={busy} onClick={() => setBusy(!busy)}>切换执行状态</button>
        <button className="secondary" aria-pressed={dark} onClick={() => {
          document.documentElement.dataset.theme = dark ? "jade" : "night";
          setDark(!dark);
        }}>切换深浅主题</button>
      </div>
      <section className="main" style={{ minHeight: 0 }}>
        <ComposerCard
          client={client} sessionId="fixture" workspaceId="workspace" busy={busy} chip="miniQ"
          placeholder={busy ? "任务执行中，发送的消息会加入队列…" : "随心输入，/ 使用命令与技能，@ 引用文件"}
          draftKey="queue-fixture" allowGoal
          queueSlot={<QueueBar queue={queue} onUpdate={updateContent}
            onRemove={async (id) => setQueue((items) => items.filter((item) => item.id !== id))}
            onSteer={async (id) => { setQueue((items) => items.filter((item) => item.id !== id)); setNotice("已调整方向（本地模拟）"); }}
            onMove={async (item, direction) => setQueue((items) => {
              const from = items.findIndex((value) => value.id === item.id);
              const to = from + (direction === "up" ? -1 : 1);
              const next = [...items];
              [next[from], next[to]] = [next[to], next[from]];
              return next;
            })} />}
          permissionSlot={<SessionPermissionControls client={client} sessionId="fixture" />}
          modelSlot={<SessionModelControls client={client} model={model} busy={busy} />}
          onSend={(content) => {
            if (busy) setQueue((items) => [...items, { id: String(Date.now()), sessionId: "fixture", content, position: items.length + 1, createdAt: new Date().toISOString() }]);
            setNotice(busy ? "已加入队列（本地模拟）" : "已发送（本地模拟）");
            return true;
          }}
          onCancel={() => { setBusy(false); setQueue([]); setNotice("已停止并清空队列（本地模拟）"); }}
          onError={(message) => {
            if (!message.includes("拖入文件")) setNotice(message);
          }}
        />
      </section>
      <p role="status">{notice}</p>
    </main>
  );
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Fixture />);
