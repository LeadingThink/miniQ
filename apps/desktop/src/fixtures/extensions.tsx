import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ExtensionCenter,
  type ExtensionSection,
} from "../components/ExtensionCenter";
import { ToastProvider } from "../components/ui/Toast";
import type { RpcClient } from "../rpc";
import { applyTheme } from "../theme";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/pages.css";
import "../styles/interactions.css";
import "../styles/shell.css";
import "../styles/scheduling.css";

// Development-only visual fixture. All data and mutations stay in memory.
const entries = [
  [
    "frontend-polish",
    "前端界面润色",
    "打磨页面排版、留白、交互状态和响应式布局，让界面更易用。",
  ],
  [
    "tencent-docs",
    "腾讯文档",
    "查找、阅读和编辑在线文档，整理团队资料与协作成果。",
  ],
  [
    "feishu-suite",
    "飞书协作",
    "处理飞书文档、消息、日历与多维表格，连接日常办公流程。",
  ],
  [
    "meeting-minutes",
    "会议纪要",
    "提炼会议结论、待办与负责人，生成清晰的中文会议纪要。",
  ],
  [
    "wechat-article",
    "公众号文章",
    "从选题到成稿，编写结构清楚、表达自然的中文公众号文章。",
  ],
  ["poster-cn", "中文海报", "结合中文字体与视觉层级，制作活动海报和社交封面。"],
  [
    "spreadsheet-workflow",
    "表格处理",
    "读取和整理电子表格，核对数据并生成可交付的工作表。",
  ],
  [
    "data-report",
    "数据分析报告",
    "围绕业务问题分析数据，用图表与文字解释结论。",
  ],
  [
    "stock-analysis-cn",
    "个股分析",
    "结合行情、财报与业务信息，形成有依据的公司研究。",
  ],
  [
    "travel-plan-cn",
    "旅行规划",
    "按时间、预算和兴趣安排路线，整理交通与住宿选择。",
  ],
  [
    "weather-cn",
    "天气查询",
    "查询城市天气与未来预报，帮助安排出行与日常活动。",
  ],
  [
    "systematic-debugging",
    "系统化调试",
    "从复现、定位到验证，逐步解决软件故障与异常行为。",
  ],
  [
    "grill-me",
    "需求追问",
    "通过具体问题明确目标、约束与取舍，形成可执行方案。",
  ],
  [
    "research-report",
    "研究报告",
    "检索资料、交叉验证来源，形成有引用依据的研究报告。",
  ],
  ["hyperframes", "视频制作", "编排画面、字幕与节奏，制作可渲染的视频内容。"],
  [
    "apple-notes-reminders",
    "备忘录与提醒",
    "整理 Apple 备忘录和提醒事项，把想法转成日常待办。",
  ],
];
let skills = entries.map(([name, displayName, description], index) => ({
  name,
  displayName,
  description,
  enabled: index !== 11,
  version: 1,
  source: index === 3 ? "user" : "bundled",
  origin: "visual-fixture",
  dependencies: index === 14 ? [{ command: "ffmpeg", available: false }] : [],
}));
let servers = [
  {
    name: "tencent-docs",
    pluginName: "腾讯办公套件",
    description: "查找、阅读和编辑腾讯文档。",
    status: "configured",
  },
  {
    name: "tencent-smartsheet",
    pluginName: "腾讯办公套件",
    description: "管理智能表格与结构化协作数据。",
    status: "configured",
  },
  {
    name: "kdocs",
    pluginName: "国内协作平台",
    description: "访问金山文档与 WPS 在线协作资料。",
    status: "configured",
  },
  {
    name: "notion",
    pluginName: "Notion",
    description: "检索知识库、阅读页面与管理数据库。",
    status: "running",
    tools: [{ name: "search", description: "搜索页面" }],
  },
  {
    name: "linear",
    pluginName: "Linear",
    description: "管理项目、需求和团队议题。",
    status: "error",
    error: "连接失败，请检查网络后重试。",
  },
].map((server) => ({
  ...server,
  command: "npx",
  args: ["-y", "mcp-remote", "https://example.invalid/mcp"],
  enabled: true,
  source: "plugin",
  pluginId: server.pluginName,
  readOnly: true,
}));
const client = {
  sshHost: null,
  onEvent: () => () => undefined,
  call: async (method: string, params?: Record<string, unknown>) => {
    if (method === "skill.list") return { skills };
    if (method === "skill.read")
      return {
        ...skills.find((skill) => skill.name === params?.name),
        body: "## 能力说明\n\n此页使用合成数据验证真实组件的布局与交互。\n\n## 使用方式\n\n在对话中描述任务，miniQ 会根据需要选择已启用的技能。",
        files: [],
      };
    if (method === "skill.setEnabled") {
      skills = skills.map((skill) =>
        skill.name === params?.name
          ? { ...skill, enabled: Boolean(params?.enabled) }
          : skill,
      );
      return {};
    }
    if (method === "mcp.list") return { servers };
    if (method === "plugin.list") return { plugins: [] };
    if (method === "mcp.update") return {};
    throw new Error(`验收页未接入 ${method}`);
  },
} as unknown as RpcClient;
function Fixture() {
  const [selected, setSelected] = useState<ExtensionSection>("skills");
  const [dark, setDark] = useState(false);
  return (
    <ToastProvider>
      <div
        style={{ height: "100dvh", display: "flex", flexDirection: "column" }}
      >
        <div
          style={{
            padding: "8px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 12,
            color: "var(--text-dim)",
            flexWrap: "wrap",
          }}
        >
          <span>开发验收 · 合成数据，不连接外部服务</span>
          <button
            className="ghost"
            onClick={() => {
              applyTheme(dark ? "jade" : "night");
              setDark(!dark);
            }}
          >
            切换主题
          </button>
        </div>
        <ExtensionCenter
          client={client}
          workspaceId={null}
          selected={selected}
          onSelect={setSelected}
          onClose={() => setSelected("skills")}
        />
      </div>
    </ToastProvider>
  );
}
if (import.meta.env.DEV) {
  applyTheme("jade");
  const root = createRoot(document.getElementById("root")!);
  root.render(<Fixture />);
  import.meta.hot?.dispose(() => root.unmount());
}
