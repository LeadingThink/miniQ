import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentPanel } from "../components/AgentPanel";
import type { AgentSummary } from "../components/AgentSummary";
import {
  SessionSummaryCard,
  type SessionSummarySection,
} from "../components/SessionSummaryCard";
import { SessionModelControls } from "../components/SessionModelControls";
import { WorkbenchOverview } from "../components/WorkbenchOverview";
import { OpenPreviewButton } from "../components/OpenPreviewButton";
import { ProjectDirectories } from "../components/ProjectDirectories";
import { SessionFileAccess } from "../sessionFileAccess";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import type { useSessionModel } from "../hooks/useSessionModel";
import type { RpcClient } from "../rpc";
import { applyTheme } from "../theme";
import {
  DEFAULT_MODEL_SETTINGS,
  type SessionModelSettings,
} from "../modelSelection";
import "@fontsource-variable/inter/wght.css";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/experience.css";
import "../components/WorkbenchToolbar.css";
import "../components/AppStatus.css";
import "./workspacePanels.css";

const agents: AgentSummary[] = [
  {
    agentId: "workflow",
    parentId: null,
    name: "product-workflow-research",
    description: "核实真实前端流程与界面结构",
    status: "completed",
    model: "gpt-6.1-sol",
    createdAt: "2026-10-24T10:40:00Z",
    queuedMessages: 0,
    error: null,
    elapsedMs: 1264000,
  },
  {
    agentId: "capability",
    parentId: null,
    name: "product-capability-research",
    description: "核实项目技术亮点与能力边界",
    status: "failed",
    model: "gpt-6.1-sol",
    createdAt: "2026-10-24T10:40:00Z",
    queuedMessages: 0,
    error: "请求失败",
    elapsedMs: 1148000,
  },
  {
    agentId: "grammar",
    parentId: null,
    name: "核实语法规则与属性",
    description: "只读核查语法检索和图片属性推断的实现",
    status: "running",
    model: "gpt-6.1-sol",
    createdAt: "2026-10-24T10:40:00Z",
    queuedMessages: 0,
    error: null,
  },
  {
    agentId: "media",
    parentId: null,
    name: "整理动画与音频素材",
    description: "整理可用于演示的素材及来源",
    status: "cancelled",
    model: "gpt-6.1-sol",
    createdAt: "2026-10-24T10:40:00Z",
    queuedMessages: 0,
    error: null,
  },
];
const client = {
  mode: "local",
  onStatus: () => () => {},
  call: async (
    method: string,
    params: { path?: string; model?: string; agentId?: string },
  ) => {
    if (method === "model.list")
      return {
        models: [
          "gpt-6.1-sol",
          "gpt-6-astra",
          "gpt-6-luna",
          "claude-opus-4.8",
          "claude-opus-5",
          "claude-sonnet-4.6",
          "claude-sonnet-5-5",
          "codex-auto-review",
          "deepseek-chat",
          "minimax-m3",
        ],
      };
    if (method === "model.describe")
      return {
        reasoningEfforts:
          params.model === "deepseek-chat"
            ? []
            : [
                "none",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
                "ultra",
              ],
      };
    if (method === "agent.output")
      return {
        ...agents.find((agent) => agent.agentId === params.agentId),
        result: "已核对相关文件，完整结果保留在本任务中。",
      };
    if (method === "file.list") {
      const path = params.path || "D:/study/globalcompai";
      const root = "D:/study/globalcompai";
      return {
        path,
        parent: path === root ? null : root,
        roots: [root],
        nextCursor: null,
        entries: (path === root
          ? [
              ".claude",
              ".codex-backup-setup",
              "src",
              "README.md",
              "演示素材与使用说明.md",
            ]
          : ["index.ts", "项目介绍与使用流程.md"]
        ).map((name) => ({
          name,
          path: `${path}/${name}`,
          directory: !name.endsWith(".md") && !name.endsWith(".ts"),
          size: 2048,
        })),
      };
    }
    throw new Error(`样例不支持 ${method}`);
  },
} as unknown as RpcClient;

function Fixture() {
  const [expanded, setExpanded] = useState<SessionSummarySection | null>(
    "agents",
  );
  const [settings, setSettings] = useState<SessionModelSettings>({
    ...DEFAULT_MODEL_SETTINGS,
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
  });
  const [notice, setNotice] = useState("本页使用样例数据，不连接真实会话。");
  const [dark, setDark] = useState(false);
  const [directoriesOpen, setDirectoriesOpen] = useState(false);
  const model: ReturnType<typeof useSessionModel> = {
    settings,
    effective: { ...settings, model: settings.model || "gpt-6.1-sol" },
    ready: true,
    pending: false,
    error: "",
    update: async (next: SessionModelSettings) => {
      setSettings(next);
      setNotice(`已保存：${next.model} / ${next.reasoningEffort ?? "默认"}`);
    },
    reload: async () => {},
  };
  const app = {
    client,
    busy: false,
    setError: setNotice,
    catalog: {
      currentSessionId: "sample",
      currentSession: {
        title: "项目介绍与使用演示动画制作",
        workingDirectory: "D:/study/globalcompai",
      },
      currentWorkspacePaths: ["D:/study/globalcompai"],
    },
    feed: {
      artifacts: [],
      nextCursor: null,
      plan: [
        {
          content: "检查项目，确认产品特点、使用流程和可展示的真实素材",
          status: "completed",
        },
        {
          content: "设计原创分镜、动效风格及音乐音效方案",
          status: "completed",
        },
        { content: "制作动画并合成音乐、音效和旁白", status: "in_progress" },
        { content: "检查画面与音频，交付成片和制作文件", status: "pending" },
      ],
    },
    preview: { canReopenClosedTab: false },
  } as unknown as MiniqAppController;
  const launch = () => setNotice("工作面板入口已触发");
  return (
    <main className="workspace-panels-fixture">
      <header className="fixture-tools">
        <span>{notice}</span>
        <SessionFileAccess client={client} sessionId="sample">
          <OpenPreviewButton
            workspacePath="D:/study/globalcompai"
            scope="sample"
            onOpen={(target) => setNotice(`打开文件：${target.path}`)}
            onError={setNotice}
          />
        </SessionFileAccess>
        <button
          type="button"
          className="ghost"
          onClick={() => setDirectoriesOpen(true)}
        >
          项目目录
        </button>
        <button
          onClick={() => {
            applyTheme(dark ? "jade" : "night");
            setDark(!dark);
          }}
        >
          切换主题
        </button>
      </header>
      {directoriesOpen && (
        <ProjectDirectories
          workspace={{
            id: "sample",
            name: "示例项目",
            path: "D:/study/globalcompai",
            additionalPaths: [],
            createdAt: "2026-10-24T00:00:00Z",
            updatedAt: "2026-10-24T00:00:00Z",
          }}
          sessions={[]}
          onSave={async () => {
            setNotice("目录已保存");
          }}
          onClose={() => setDirectoriesOpen(false)}
        />
      )}
      <div className="fixture-columns">
        <section className="fixture-conversation">
          <div className="fixture-summary-toolbar">
            <SessionSummaryCard
              sessionId="sample"
              diff={{
                files: [{}, {}, {}, {}, {}],
                additions: 1050,
                deletions: 0,
              }}
              agents={agents}
              sources={[]}
              pullRequests={[]}
              expanded={expanded}
              onExpandedChange={setExpanded}
              onOpenReview={launch}
              onOpenUrl={launch}
              agentPanel={
                <AgentPanel
                  client={client}
                  sessionId="sample"
                  busy={false}
                  agents={agents}
                />
              }
            />
          </div>
          <div className="fixture-chat-copy">
            <h2>项目介绍与使用演示</h2>
            <p>
              会话内容区域。顶部摘要显示子任务与变更，底部选择模型后悬停查看思考强度。
            </p>
          </div>
          <div className="fixture-composer">
            <div>描述你的下一步需求…</div>
            <SessionModelControls client={client} model={model} busy={false} />
          </div>
        </section>
        <WorkbenchOverview
          app={app}
          onOpenFile={(target) => setNotice(`打开文件：${target.path}`)}
          launcher={{
            onOpenFiles: launch,
            onOpenBrowser: launch,
            onOpenReview: launch,
            changes: 5,
            onOpenGit: launch,
            onOpenTerminal: launch,
          }}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
