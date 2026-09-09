import { Check, Clock3, LoaderCircle, MessageCircleQuestion, RotateCcw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { errorMessage } from "../errorMessage";
import type { LocalFileTarget } from "../localFiles";
import type { Question } from "../types";
import { Md } from "./Md";
import "./QuestionCard.css";

export interface QuestionCardProps {
  question: Question;
  onResolve: (questionId: string, answer: string) => void | Promise<void>;
  workspacePath?: string | null;
  onOpenFile?: (target: LocalFileTarget) => void;
  onOpenUrl?: (url: string) => void;
}

function QuestionCountdown({ question }: { question: Question }) {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    const seconds = question.autoContinueAfterSeconds;
    const deadline = Date.parse(question.createdAt) + (seconds ?? 0) * 1_000;
    if (!seconds || !Number.isFinite(deadline)) {
      setRemaining(null);
      return;
    }
    const update = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [question.autoContinueAfterSeconds, question.createdAt]);
  if (remaining === null) return null;
  const time = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  return <div className="question-timeout">
    <Clock3 size={14} aria-hidden="true" />
    <span>完全访问模式：{time} 后采用{question.defaultAnswer ? `“${question.defaultAnswer}”` : "默认方案"}继续</span>
  </div>;
}

// Choice labels remain non-interactive; links and file actions belong to the prompt.
function OptionText({ children }: { children: string }) {
  return <ReactMarkdown
    allowedElements={["p", "strong", "em", "del", "code", "br"]}
    unwrapDisallowed
    skipHtml
    remarkPlugins={[remarkGfm]}
    components={{ p: ({ children: content }) => <span className="question-option-paragraph">{content}</span> }}
  >{children}</ReactMarkdown>;
}

function QuestionOptions(props: {
  question: Question;
  selected: string[];
  onSelect: (option: string) => void;
  disabled: boolean;
}) {
  const groupId = useId();
  const { question } = props;
  if (!question.options.length) return null;
  return <fieldset className="question-options" disabled={props.disabled}>
    <legend>{question.multiSelect ? "选择回答（可多选）" : "选择回答"}</legend>
    {question.options.map((option, index) => {
      const id = `${groupId}-${index}`;
      const description = question.optionDescriptions?.[option];
      const selected = props.selected.includes(option);
      return <label key={id} className={`question-option${selected ? " selected" : ""}`}>
        <input
          type={question.multiSelect ? "checkbox" : "radio"}
          name={groupId}
          value={option}
          checked={selected}
          aria-labelledby={`${id}-label`}
          aria-describedby={description ? `${id}-description` : undefined}
          onChange={() => props.onSelect(option)}
        />
        <span className="question-option-content">
          <span id={`${id}-label`} className="question-option-label"><OptionText>{option}</OptionText></span>
          {description && <span id={`${id}-description`} className="question-option-description"><OptionText>{description}</OptionText></span>}
        </span>
      </label>;
    })}
  </fieldset>;
}

function QuestionAnswerForm({ question, onResolve }: Pick<QuestionCardProps, "question" | "onResolve">) {
  const [custom, setCustom] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const inputId = useId();
  const answer = [...selected, ...(custom.trim() ? [custom.trim()] : [])].join("\n");
  const disabled = submitting || sent;
  const select = (option: string) => {
    setSelected((current) => question.multiSelect
      ? current.includes(option) ? current.filter((value) => value !== option) : [...current, option]
      : [option]);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || !answer) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onResolve(question.id, answer);
      setSent(true);
    } catch (cause) {
      inFlight.current = false;
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };
  return <form className="question-answer" aria-label="回答确认问题" onSubmit={(event) => void submit(event)}>
    <QuestionOptions question={question} selected={selected} onSelect={select} disabled={disabled} />
    {selected.length > 0 && <button type="button" className="question-clear" disabled={disabled} onClick={() => setSelected([])}>
      <RotateCcw size={13} aria-hidden="true" />清除选择
    </button>}
    <label className="question-custom-label" htmlFor={inputId}>{question.options.length ? "补充或其他回答" : "你的回答"}</label>
    <textarea
      id={inputId}
      className="question-input"
      value={custom}
      rows={3}
      disabled={disabled}
      onChange={(event) => setCustom(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)
          && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
    />
    {error && <div className="question-error" role="alert">回答未发送：{error}</div>}
    <div className="question-footer">
      <span className="question-submit-status" role="status">{sent ? "回答已发送" : submitting ? "正在发送回答" : ""}</span>
      <button type="submit" className="question-submit" disabled={disabled || !answer}>
        {submitting ? <LoaderCircle size={15} className="question-spinner" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
        确认回答
      </button>
    </div>
  </form>;
}

export function QuestionCard(props: QuestionCardProps) {
  const headingId = useId();
  return <section className="question-card" aria-labelledby={headingId}>
    <header className="question-heading">
      <MessageCircleQuestion size={17} aria-hidden="true" />
      <h3 id={headingId}>{props.question.header || "miniQ 想确认"}</h3>
    </header>
    <div className="question-prompt" role="region" aria-label="问题详情" tabIndex={0}>
      <Md workspacePath={props.workspacePath} onOpenFile={props.onOpenFile} onOpenUrl={props.onOpenUrl}>{props.question.prompt}</Md>
    </div>
    <QuestionCountdown question={props.question} />
    <QuestionAnswerForm key={props.question.id} question={props.question} onResolve={props.onResolve} />
  </section>;
}
