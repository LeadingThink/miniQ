import {
  ClipboardList,
  FileSearch,
  FileText,
  Table2,
} from "lucide-react";
import "./StarterPrompts.css";

export interface StarterPrompt {
  id: string;
  title: string;
  description: string;
  prompt: string;
  icon: typeof FileSearch;
}

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    id: "brief-documents",
    title: "把资料整理成简报",
    description: "用文档或网页资料，整理重点与来源，形成文字简报。",
    prompt:
      "目标：把一组资料整理成一份简洁、可编辑的简报。\n输入：请读取我提供的文档、PDF 或网页资料，保留关键事实和来源。\n交付物：输出一份 Markdown 简报，包含摘要、关键发现、待确认事项和来源。\n\n补充要求：",
    icon: FileSearch,
  },
  {
    id: "pdf-notes",
    title: "提取 PDF 要点",
    description: "提供 PDF 与关注主题，得到附页码的结论与阅读笔记。",
    prompt:
      "目标：阅读指定 PDF，提炼对当前工作有用的信息。\n输入：PDF 文件或工作区中的 PDF，以及需要关注的主题：\n交付物：输出结构化 Markdown 笔记，包含结论、依据、关键页码和待核实问题。\n\n补充要求：",
    icon: FileText,
  },
  {
    id: "spreadsheet-review",
    title: "分析一份表格",
    description: "提供 CSV 或 Excel 与业务问题，得到分析结论和依据表格。",
    prompt:
      "目标：分析一份 CSV 或 Excel 表格，回答业务问题并指出异常。\n输入：表格文件；分析口径、时间范围或需要关注的列：\n交付物：先说明数据范围和处理口径，再输出结论、关键行号或字段依据，以及可复核的 Markdown 表格。\n\n补充要求：",
    icon: Table2,
  },
  {
    id: "meeting-brief",
    title: "整理会议材料",
    description: "提供主题与会议资料，得到会前简报、议程和决策问题清单。",
    prompt:
      "目标：把会议相关资料整理成一份会前简报。\n输入：会议主题、已有文档或 PDF、参会人和时间限制（可选）：\n交付物：输出 Markdown，包含背景、议程、关键事实、需要决策的问题和会后行动项草稿；不替我发送或联系任何人。\n\n补充要求：",
    icon: ClipboardList,
  },
];

export interface StarterShortcut {
  id: string;
  title: string;
  description: string;
  icon: typeof FileSearch;
  onSelect: () => void;
}

export function StarterPrompts(props: {
  onSelect: (prompt: StarterPrompt) => void;
  shortcuts: StarterShortcut[];
}) {
  const cards = [
    ...STARTER_PROMPTS.map((item) => ({
      ...item,
      onSelect: () => props.onSelect(item),
    })),
    ...props.shortcuts,
  ];
  return (
    <section className="starter-prompts-v2" aria-labelledby="starter-prompts-title">
      <div className="starter-prompts-v2-heading">
        <div>
          <h2 id="starter-prompts-title">先选一个示例，再编辑任务</h2>
          <p>示例只会填入草稿。补充你的要求，确认后再发送。</p>
        </div>
        <span className="starter-prompts-v2-count" aria-hidden="true">
          {STARTER_PROMPTS.length} 个示例
        </span>
      </div>
      <div className="starter-prompts-v2-list" aria-label="办公任务示例">
      {cards.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            className="starter-prompt-v2"
            onClick={item.onSelect}
          >
            <span className="starter-prompt-v2-icon" aria-hidden="true">
              <Icon size={16} />
            </span>
            <span className="starter-prompt-v2-copy">
              <strong>{item.title}</strong>
              <small>{item.description}</small>
            </span>
          </button>
        );
      })}
      </div>
    </section>
  );
}
