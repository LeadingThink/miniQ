import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerSettings } from "../components/ComputerSettings";
import { AgentPanel } from "../components/AgentPanel";
import { Timeline } from "../components/Timeline";
import { SpreadsheetDataView } from "../components/SpreadsheetPreview";
import { PdfSearch } from "../components/PdfSearch";
import { PdfPreview } from "../components/PdfPreview";
import { pdfFixtureBase64 } from "./pdf";
import { PreviewTabs } from "../components/PreviewTabs";
import { MarkdownPreview } from "../components/MarkdownPreview";
import type { RpcClient } from "../rpc";
import type { Message, ToolCall } from "../types";
import { EMPTY_PREVIEW_TABS, removePreviewTab, selectPreviewTab } from "../previewTabs";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/review.css";
import "../styles/experience.css";

const agents = ["writer", "reviewer", "browser-check"].map((name, index) => ({
  agentId: name,
  name,
  parentId: index === 2 ? "reviewer" : null,
  description: ["完成产品报告", "核对引用与数据", "验证浏览器与预览"][index],
  status: index === 1 ? "running" : index === 2 ? "failed" : "completed",
  model: ["gpt-5.6-sol", "claude-sonnet-4.6", "gemini-3.1-pro"][index],
  createdAt: new Date().toISOString(),
  result: `## ${name}\n\n完整子任务证据。\n\n- 原始记录保留\n- 会话身份隔离`,
}));
const client = {
  mode: "local",
  onStatus: () => () => {},
  call: async (method: string, params?: { agentId?: string }) => {
    if (method === "agent.list") return { agents };
    if (method === "agent.output" || method === "agent.stop")
      return agents.find((agent) => agent.agentId === params?.agentId);
    if (method === "computer.requestPermission") throw new Error("隔离测试：不会请求真实系统授权");
    return {
      platform: "macos",
      processId: 4242,
      executable: "/Applications/miniQ.app/Contents/MacOS/miniq-daemon",
      screenRecording: "denied",
      accessibility: "granted",
      displayServer: null,
    };
  },
} as unknown as RpcClient;
const messages = [
  {
    id: "user",
    sessionId: "test",
    role: "user",
    content: "检查报告，验证浏览器，再生成可发布的结果。",
    createdAt: "2026-09-08T00:00:00Z",
  },
  {
    id: "assistant",
    sessionId: "test",
    role: "assistant",
    content: "已核对数据源。正在并行检查页面交互、文件预览和任务隔离。",
    createdAt: "2026-09-08T00:00:01Z",
  },
] as Message[];
const calls = Array.from({ length: 75 }, (_, index) => ({
  id: `tool-${index}`,
  sessionId: "test",
  toolName: index === 74 ? "browser_automation" : "shell_run",
  status: index === 74 ? "running" : index === 35 ? "failed" : "succeeded",
  input: { command: `验证模块 ${index}: 保留完整的输出记录与路径` },
  output: {
    stdout: `检查 ${index}\n` + "完整证据行\n".repeat(160),
    exitCode: index === 35 ? 1 : 0,
  },
  createdAt: "2026-09-08T00:00:02Z",
  completedAt: index === 74 ? null : "2026-09-08T00:00:03Z",
})) as ToolCall[];
const plan = [
  { content: "检查产品报告", status: "completed" as const },
  { content: "验证浏览器与文件预览", status: "in_progress" as const },
  { content: "整理验收结果", status: "pending" as const },
];
const sheets = [
  {
    sheet: "检查明细",
    data: Array.from({ length: 450 }, (_, i) => [i, `模块 ${i}`, i % 2 === 0]),
  },
  { sheet: "结论", data: [["验证范围", "所有行均可筛选、排序并保留原始行号"]] },
];
const pdf = {
  numPages: 12,
  getPage: async (page: number) => ({
    getTextContent: async () => ({
      items: [{ str: page % 3 === 0 ? "miniQ searchable evidence" : "Other page" }],
    }),
  }),
};

function Fixture() {
  const [mode, setMode] = useState("执行");
  const [page, setPage] = useState(1);
  const [previewError, setPreviewError] = useState("");
  const [tabs, setTabs] = useState(() =>
    selectPreviewTab(
      selectPreviewTab(EMPTY_PREVIEW_TABS, {
        path: "/report/分析.md",
        line: null,
        column: null,
      }),
      { path: "/checks/分析.md", line: null, column: null },
    ),
  );
  return (
    <main
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        background: "var(--bg)",
      }}
    >
      <header
        style={{
          display: "flex",
          flexShrink: 0,
          gap: 12,
          alignItems: "center",
          padding: 12,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <strong>miniQ</strong>
        <span>隔离验收</span>
        <select aria-label="验收视图" value={mode} onChange={(event) => setMode(event.target.value)}>
          {["执行", "权限", "表格", "PDF 搜索", "PDF 渲染", "文件标签"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </header>
      {previewError && <p role="alert">{previewError}</p>}
      {mode === "执行" && (
        <>
          <AgentPanel client={client} sessionId="test" busy />
          <Timeline
            messages={messages}
            toolCalls={calls}
            approvals={[]}
            questions={[]}
            plan={plan}
            artifacts={[]}
            queue={[]}
            streamingText=""
            turnProgress={null}
            busy
            onResolveApproval={() => {}}
            onResolveQuestion={() => {}}
            onRollback={() => {}}
            onOpenFile={() => {}}
            onOpenUrl={() => {}}
            onSteerQueued={() => {}}
            onRemoveQueued={() => {}}
            onError={() => {}}
          />
        </>
      )}
      {mode === "权限" && (
        <div
          style={{
            maxWidth: 640,
            width: "100%",
            margin: "0 auto",
            overflow: "auto",
          }}
        >
          <ComputerSettings client={client} />
        </div>
      )}
      {mode === "表格" && <SpreadsheetDataView sheets={sheets} onError={() => {}} />}
      {mode === "PDF 搜索" && (
        <>
          <PdfSearch document={pdf} onPage={setPage} />
          <output aria-label="当前 PDF 页">第 {page} 页</output>
        </>
      )}
      {mode === "PDF 渲染" && <PdfPreview dataBase64={pdfFixtureBase64()} onError={setPreviewError} />}
      {mode === "文件标签" && (
        <>
          <PreviewTabs
            tabs={tabs.targets}
            active={tabs.active ?? ""}
            id="fixture-file"
            onSelect={(target) => setTabs(selectPreviewTab(tabs, target))}
            onClose={(path) => setTabs(removePreviewTab(tabs, path))}
          />
          <div id="fixture-file" role="tabpanel" style={{ overflow: "auto", padding: 20 }}>
            <MarkdownPreview
              content={`# ${tabs.active ?? "无文件"}\n\n## 验收\n\n| 模块 | 状态 |\n| --- | --- |\n| 多路径文件 | 保持独立 |\n| 工作区 | 不串会话 |`}
              workspacePath="/fixture"
              currentFilePath={tabs.active ?? ""}
              onOpenFile={() => {}}
            />
          </div>
        </>
      )}
    </main>
  );
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Fixture />);
