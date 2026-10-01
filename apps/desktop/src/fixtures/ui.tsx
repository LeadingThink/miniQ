import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FolderPlus, MessageSquare, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { SearchOverlay } from "../components/Search";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ListRow,
  LoadingState,
  Menu,
  MenuItem,
  MenuSeparator,
  Skeleton,
  Spinner,
  Switch,
  ToastProvider,
  showUndoToast,
  useToast,
} from "../components/ui";
import { initializeAppearance } from "../theme";
import type { Session, Workspace } from "../types";
import "@fontsource-variable/inter/wght.css";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/review.css";
import "../styles/pages.css";
import "../styles/scheduling.css";
import "../styles/experience.css";
import "../styles/theme-picker.css";

// Static gallery of the shared UI primitives. `?view=palette|dialog` opens the overlays.
const view = new URLSearchParams(location.search).get("view");
const now = new Date().toISOString();
const workspaces: Workspace[] = [
  { id: "w1", name: "miniQ", path: "/Users/demo/miniQ", additionalPaths: [], createdAt: now, updatedAt: now },
];
const sessions = ["重构登录流程", "修复设置页崩溃", "设计命令面板"].map(
  (title, index) =>
    ({
      id: `s${index}`,
      workspaceId: "w1",
      workingDirectory: "/Users/demo/miniQ",
      title,
      status: "idle",
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: new Date(Date.now() - index * 3_600_000).toISOString(),
    }) as Session,
);

function Gallery() {
  const toast = useToast();
  const [switches, setSwitches] = useState([true, false]);
  const [selected, setSelected] = useState("s0");
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(view === null);

  useEffect(() => {
    if (view !== null) return;
    showUndoToast(toast, {
      message: "已删除会话“设计命令面板”",
      duration: 600_000,
      onCommit: () => undefined,
      onUndo: () => undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page" style={{ height: "100vh", overflow: "auto" }}>
      <div className="page-inner wide" style={{ display: "grid", gap: 24 }}>
        <h1>UI 组件</h1>
        <section style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Button icon={<Plus size={14} />}>新建</Button>
          <Button variant="secondary">次要操作</Button>
          <Button variant="ghost">幽灵按钮</Button>
          <Button variant="danger" icon={<Trash2 size={14} />}>删除</Button>
          <Button size="sm" variant="secondary">小号</Button>
          <Button disabled>已禁用</Button>
          <Switch checked={switches[0]} label="开关一" onChange={(on) => setSwitches([on, switches[1]])} />
          <Switch checked={switches[1]} label="开关二" onChange={(on) => setSwitches([switches[0], on])} />
          <Switch checked disabled label="禁用开关" onChange={() => undefined} />
          <Spinner size={16} />
          <Button ref={menuAnchor} variant="ghost" size="sm" aria-label="更多操作" onClick={() => setMenuOpen(true)}>⋯</Button>
          <Menu open={menuOpen} anchorRef={menuAnchor} onClose={() => setMenuOpen(false)} label="会话操作">
            <MenuItem icon={<Pencil size={14} />} shortcut="⌘R">重命名</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 size={14} />} danger>删除</MenuItem>
          </Menu>
        </section>
        <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <div>
            {sessions.map((session) => (
              <ListRow
                key={session.id}
                leading={<MessageSquare size={14} />}
                title={session.title}
                subtitle="miniQ · 1 小时前"
                selected={selected === session.id}
                onSelect={() => setSelected(session.id)}
              />
            ))}
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <Skeleton lines={3} />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Skeleton circle width={32} height={32} />
              <Skeleton width="60%" />
            </div>
            <LoadingState label="正在读取记忆…" />
          </div>
        </section>
        <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <EmptyState
            icon={<Sparkles size={22} />}
            title="还没有技能"
            description="把常用流程保存为技能，之后可以随时复用"
            action={<Button variant="secondary" size="sm">新建技能</Button>}
          />
          <EmptyState compact icon={<FolderPlus size={20} />} title="还没有项目" description="点击新对话选择或创建一个项目开始协作" />
        </section>
      </div>
      {view === "dialog" && (
        <ConfirmDialog
          open
          tone="danger"
          title="删除项目“miniQ”？"
          description="该项目下的所有会话也将被删除，此操作无法撤销。"
          confirmLabel="删除项目"
          onCancel={() => undefined}
          onConfirm={() => undefined}
        />
      )}
      {view === "palette" && (
        <SearchOverlay
          sessions={sessions}
          workspaces={workspaces}
          commands={[
            { id: "new", label: "新建对话", icon: "new", shortcut: "⌘N", run: () => undefined },
            { id: "settings", label: "打开设置", icon: "settings", shortcut: "⌘,", run: () => undefined },
            { id: "skills", label: "技能", icon: "skills", run: () => undefined },
          ]}
          onSelectSession={() => undefined}
          onClose={() => undefined}
        />
      )}
    </div>
  );
}

if (import.meta.env.DEV) {
  initializeAppearance();
  createRoot(document.getElementById("root")!).render(
    <ToastProvider>
      <Gallery />
    </ToastProvider>,
  );
}
