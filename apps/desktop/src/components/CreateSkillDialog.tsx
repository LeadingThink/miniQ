import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Sparkles, XCircle } from "lucide-react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import "./CreateSkillDialog.css";

export interface SkillCheck { id: string; level: "ok" | "warning" | "error"; message: string }
export interface SkillValidation { valid: boolean; name: string | null; existingSkill: boolean; checks: SkillCheck[] }
interface CreatedDraft { content: string; name: string; description: string; validation: SkillValidation }

type Phase = "describe" | "generating" | "review" | "saving";

const EXAMPLES = [
  "每周五汇总本周 git 提交和会议纪要，生成一份周报草稿，发送前让我确认",
  "检查项目依赖是否有安全更新，列出受影响的包和升级建议，不直接修改文件",
  "写一篇文章：阅读参考资料用 gemini 3.8，写作用 gpt 6.1 sol，导出 Word 用 deepseek flash，各交给一个子 agent",
];

const ICON = { ok: CheckCircle2, warning: AlertTriangle, error: XCircle } as const;

/** Describe a recurring task, review the generated SKILL.md and its checks, then install it. */
export function CreateSkillDialog(props: { client: RpcClient; onClose: () => void; onSaved: (name: string) => void }) {
  const [phase, setPhase] = useState<Phase>("describe");
  const [goal, setGoal] = useState("");
  const [name, setName] = useState("");
  const [draft, setDraft] = useState("");
  const [validation, setValidation] = useState<SkillValidation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const validateGeneration = useRef(0);

  // Re-validate edits so the checks always describe what will be saved.
  useEffect(() => {
    if (phase !== "review") return;
    const generation = ++validateGeneration.current;
    const timer = window.setTimeout(() => {
      void props.client.call<SkillValidation>("skill.validate", { content: draft })
        .then((result) => { if (generation === validateGeneration.current) setValidation(result); })
        .catch((cause) => { if (generation === validateGeneration.current) setError(errorMessage(cause)); });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, phase, props.client]);

  const generate = async () => {
    setError(null);
    setPhase("generating");
    try {
      const created = await props.client.call<CreatedDraft>("skill.create", { goal: goal.trim(), ...(name.trim() ? { name: name.trim() } : {}) });
      setDraft(created.content);
      setValidation(created.validation);
      setPhase("review");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("describe");
    }
  };

  const save = async () => {
    if (!validation?.valid) return;
    setError(null);
    setPhase("saving");
    try {
      const saved = await props.client.call<{ name: string }>("skill.save", { content: draft });
      props.onSaved(saved.name);
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("review");
    }
  };

  const reviewing = phase === "review" || phase === "saving";
  return (
    <Dialog
      open
      className="create-skill-dialog"
      title={reviewing ? "检查并保存技能" : "新建技能"}
      description={reviewing
        ? "可以直接修改下方内容。保存后新对话即可使用；同名技能会被覆盖，旧版本自动备份。"
        : "用一两句话描述一个会反复出现的任务。miniQ 会生成技能草稿，保存前你可以检查和修改。"}
      onClose={props.onClose}
      footer={reviewing ? <>
        <Button variant="secondary" disabled={phase === "saving"} onClick={() => { setPhase("describe"); setValidation(null); }}>返回修改描述</Button>
        <Button disabled={!validation?.valid || phase === "saving"} onClick={() => void save()}>
          {phase === "saving" ? "正在保存…" : validation?.existingSkill ? "覆盖并保存" : "保存技能"}
        </Button>
      </> : <>
        <Button variant="secondary" onClick={props.onClose}>取消</Button>
        <Button icon={phase === "generating" ? <Loader2 size={14} className="create-skill-spin" /> : <Sparkles size={14} />}
          disabled={goal.trim().length < 4 || phase === "generating"} onClick={() => void generate()}>
          {phase === "generating" ? "正在生成…" : "生成草稿"}
        </Button>
      </>}
    >
      {error && <div className="create-skill-error" role="alert">{error}</div>}
      {!reviewing ? <div className="create-skill-form">
        <label htmlFor="create-skill-goal">这个技能要做什么？</label>
        <textarea id="create-skill-goal" rows={5} value={goal} disabled={phase === "generating"} autoFocus
          placeholder="说明任务目标、何时使用、需要我确认的步骤和完成标准"
          onChange={(event) => setGoal(event.target.value)} />
        <div className="create-skill-examples" aria-label="示例">
          {EXAMPLES.map((example) => <button key={example} type="button" className="create-skill-example"
            disabled={phase === "generating"} onClick={() => setGoal(example)}>{example}</button>)}
        </div>
        <label htmlFor="create-skill-name">技能标识（可选）</label>
        <input id="create-skill-name" value={name} disabled={phase === "generating"} placeholder="weekly-report，留空则自动生成"
          onChange={(event) => setName(event.target.value)} />
      </div> : <div className="create-skill-review">
        <textarea aria-label="技能内容（SKILL.md）" className="create-skill-editor" value={draft} spellCheck={false}
          disabled={phase === "saving"} onChange={(event) => setDraft(event.target.value)} />
        <ul className="create-skill-checks" aria-label="保存前检查">
          {validation?.checks.map((item) => {
            const Icon = ICON[item.level];
            return <li key={item.id} data-level={item.level}><Icon size={14} aria-hidden="true" /><span>{item.message}</span></li>;
          })}
        </ul>
      </div>}
    </Dialog>
  );
}
