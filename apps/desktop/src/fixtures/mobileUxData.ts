import type { Message, Session, Workspace } from "../types";
import type { RpcClient } from "../rpc";
import { DEFAULT_MODEL_SETTINGS } from "../modelSelection";
import { itemMatches, type TimelineFilter } from "../timelineModel";

const at = new Date().toISOString();
export const workspaces: Workspace[] = [
  { id: "mac", name: "产品发布与用户调研", path: "/Users/demo/Projects/产品发布与用户调研", additionalPaths: [], createdAt: at, updatedAt: at },
  { id: "ssh", name: "远程数据分析与长文档处理", path: "/home/demo/projects/analysis", additionalPaths: [], createdAt: at, updatedAt: at },
];
const titles = [
  "整理三十份用户访谈，生成完整的产品改进报告，并保留每条建议对应的原始证据",
  "核对路演材料并生成适合手机阅读的商业计划书最终版本",
  "需要你确认：是否使用现有视频素材制作完整版宣传片",
  "上周销售数据处理失败，检查原因并继续完成可视化结果",
  "Compare quarterly reports and validate every customer feedback item before final delivery",
  "检查远程服务器项目的测试结果，保留完整日志并给出下一步建议",
];
export const sessions: Session[] = titles.map((title, index) => ({
  id: `mobile-${index}`, workspaceId: index < 4 ? "mac" : "ssh",
  workingDirectory: workspaces[index < 4 ? 0 : 1].path, title,
  status: index === 1 ? "running" : index === 2 ? "waiting_approval" : index === 3 ? "failed" : "idle",
  pinned: index === 0, archived: false, createdAt: at, updatedAt: at,
}));
export function history(sessionId: string): Message[] {
  return Array.from({ length: 24 }, (_, index) => ({
    id: `${sessionId}-${index}`, sessionId, role: index % 2 ? "assistant" : "user",
    content: index % 2
      ? `第 ${Math.floor(index / 2) + 1} 轮结果已整理。\n\n## 用户反馈与下一步\n\n| 反馈 | 改进 |\n|---|---|\n| 标题看不完整 | 完整换行，保留项目归属 |\n| 断线不知道怎么办 | 明确连接状态，手动重试与自动恢复 |\n| 文件预览后难以继续 | 返回会话并针对文件继续提问 |\n\n以上为本地模拟内容，不会调用模型或操作任何远程电脑。`
      : `第 ${Math.floor(index / 2) + 1} 项要求：请结合所有原始材料，保留完整说明，并确认每项结果都能在手机上方便查看。`,
    createdAt: new Date(Date.now() - (25 - index) * 60000).toISOString(),
  }));
}
const modelSettings = new Map();
export const fixtureClient = {
  mode: "remote", connected: true,
  onEvent: () => () => {}, onStatus: () => () => {},
  call: async (method: string, params: { sessionId?: string; settings?: unknown; before?: { id: string }; filter?: TimelineFilter; query?: string } = {}) => {
    if (method === "model.list") return { models: ["gpt-5.6-sol", "gemini-3.8-flash", "claude-opus-4-6", "deepseek-v4-pro-long-model-name"] };
    if (method === "model.describe") return { reasoningEfforts: ["low", "medium", "high"], contextWindow: 128000 };
    if (method === "session.modelUpdate") modelSettings.set(params.sessionId, params.settings);
    if (method === "session.modelGet" || method === "session.modelUpdate") {
      const settings = modelSettings.get(params.sessionId) ?? { ...DEFAULT_MODEL_SETTINGS, model: "gpt-5.6-sol" };
      return { settings, effective: settings };
    }
    if (method === "skill.list") return { skills: [] };
    if (method === "approval.inbox") return { entries: [], nextCursor: null };
    if (method === "session.history") {
      const matching = history(params.sessionId!).filter((message) => itemMatches({ kind: "message", at: message.createdAt, message }, params.filter ?? "all", params.query ?? ""));
      const end = params.before ? matching.findIndex((message) => message.id === params.before?.id) : matching.length;
      const start = Math.max(0, end - 8);
      const messages = matching.slice(start, end);
      return { messages, toolCalls: [], nextCursor: start ? { id: messages[0].id, at: messages[0].createdAt } : null };
    }
    throw new Error(`验收样例不支持 ${method}；未连接真实服务。`);
  },
} as unknown as RpcClient;

export const reportPath = "/Users/demo/Projects/产品发布与用户调研/outputs/2026年第三季度用户访谈与产品改进报告完整版.md";
export const report = "# 完整交付报告\n\n这份文件用来验收手机预览、完整路径和继续提问。\n\n## 改进记录\n\n" + Array.from({ length: 20 }, (_, index) => `### 第 ${index + 1} 项\n\n完整保留资料来源和后续建议。用户可以滚动阅读，也可以返回会话继续下达修改要求。`).join("\n\n");
