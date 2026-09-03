import {
  Bug,
  FileSearch,
  GitPullRequestArrow,
  WandSparkles,
} from "lucide-react";

export interface StarterPrompt {
  id: string;
  title: string;
  description: string;
  prompt: string;
  icon: typeof FileSearch;
}

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    id: "understand",
    title: "了解项目",
    description: "梳理结构、入口与关键链路",
    prompt:
      "请先了解这个项目，梳理它的目录结构、核心模块、启动方式和关键数据链路，并指出最值得优先关注的风险。",
    icon: FileSearch,
  },
  {
    id: "fix",
    title: "定位并修复问题",
    description: "从复现、根因到验证一次完成",
    prompt:
      "请帮我定位并修复这个问题：\n\n现象：\n复现步骤：\n期望行为：",
    icon: Bug,
  },
  {
    id: "build",
    title: "开发新功能",
    description: "沿用现有架构完成实现",
    prompt:
      "请在充分了解现有实现后开发这个功能，并完成相应测试：\n\n功能目标：\n验收标准：",
    icon: WandSparkles,
  },
  {
    id: "review",
    title: "审查当前改动",
    description: "优先发现回归、风险与漏测",
    prompt:
      "请审查当前工作区的代码改动，优先检查功能错误、行为回归、稳定性风险和缺失测试，并按严重程度给出结论。",
    icon: GitPullRequestArrow,
  },
];

export function StarterPrompts(props: {
  onSelect: (prompt: StarterPrompt) => void;
}) {
  return (
    <div className="starter-prompts" aria-label="任务起点">
      {STARTER_PROMPTS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            className="starter-prompt"
            onClick={() => props.onSelect(item)}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="starter-prompt-copy">
              <strong>{item.title}</strong>
              <small>{item.description}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}
