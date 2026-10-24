import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../components/Sidebar";
import { ComposerCard } from "../components/Composer";
import { ToastProvider } from "../components/ui/Toast";
import type { RpcClient } from "../rpc";
import type { Session, Workspace } from "../types";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/pages.css";
import "../styles/conversation.css";
import "../styles/interactions.css";

// Synthetic data only: this fixture never connects to a daemon or a model.
const noop = () => undefined;
const now = "2026-10-24T00:00:00Z";
const projects: Workspace[] = ["大项目", "第二项目"].map((name, index) => ({
  id: `list-fixture-${index}`,
  name,
  path: `/fixture/${index}`,
  additionalPaths: [],
  createdAt: now,
  updatedAt: now,
}));
const initialSessions: Session[] = Array.from({ length: 1800 }, (_, index) => ({
  id: `list-session-${index}`,
  workspaceId: projects[index < 1500 ? 0 : 1].id,
  workingDirectory: "/fixture",
  title: `会话 ${index}`,
  status: "idle",
  pinned: false,
  archived: index >= 1600,
  createdAt: now,
  updatedAt: now,
}));
const client = {
  call: async (method: string) => {
    if (method !== "skill.list")
      throw new Error(`Unsupported fixture method: ${method}`);
    return {
      skills: Array.from({ length: 343 }, (_, index) => ({
        name: `技能 ${index}`,
        enabled: true,
        description:
          "完整描述及参数，支持全文检索与不同高度。".repeat((index % 7) + 1) +
          ` 检索词-${index}`,
      })),
    };
  },
} as unknown as RpcClient;

function Fixture() {
  const [sessions, setSessions] = useState(initialSessions);
  const [current, setCurrent] = useState<string | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState(projects[0].id);
  const [notice, setNotice] = useState(
    "展开项目、滚动到末尾，或输入 / 测试 343 个技能。",
  );
  const update = (id: string, patch: Partial<Session>) =>
    setSessions((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  return (
    <ToastProvider>
      <div className="app" style={{ height: "100dvh" }}>
        <Sidebar
          workspaces={projects}
          sessions={sessions}
          unreadSessionIds={new Set()}
          currentSessionId={current}
          selectedWorkspaceId={selectedWorkspace}
          onSelectWorkspace={setSelectedWorkspace}
          onSelectSession={setCurrent}
          onRenameSession={(id, title) => update(id, { title })}
          onDeleteSession={(id) =>
            setSessions((items) => items.filter((item) => item.id !== id))
          }
          onSetSessionPinned={(id, pinned) => update(id, { pinned })}
          onSetSessionArchived={(id, archived) => update(id, { archived })}
          onNewChat={noop}
          onShowSearch={noop}
          onShowSchedule={noop}
          onImportSessions={noop}
          onCreateSession={noop}
          onDeleteWorkspace={noop}
          onRenameWorkspace={noop}
          onEditWorkspace={noop}
          onSessionSeen={noop}
          onShowSettings={noop}
          updateSupported={false}
          updateState={{
            phase: "idle",
            version: null,
            downloadedBytes: 0,
            totalBytes: null,
            error: null,
            busyReason: null,
            releaseNotes: [],
          }}
          onCheckForUpdates={noop}
          onInstallUpdate={noop}
          onError={setNotice}
        />
        <main
          style={{
            flex: 1,
            minWidth: 0,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <h1>大列表验收</h1>
          <p role="status">
            {notice} 当前：{current ?? "无"}
          </p>
          <button onClick={() => setCurrent("list-session-1200")}>
            定位会话 1200
          </button>
          <div style={{ flex: 1 }} />
          <ComposerCard
            busy={false}
            placeholder="输入 / 测试技能"
            client={client}
            workspaceId={projects[0].id}
            onSend={(content) => setNotice(content)}
            onError={setNotice}
          />
        </main>
      </div>
    </ToastProvider>
  );
}

if (import.meta.env.DEV) {
  const root = createRoot(document.getElementById("root")!);
  root.render(<Fixture />);
  if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
}
