import { ChevronRight, History } from "lucide-react";
import { useId, useState } from "react";
import type { Message } from "../types";
import type { TimelineProps } from "./Timeline";
import { DeepThinking } from "./DeepThinking";
import { Md } from "./Md";
import "./InterimReply.css";

/** Rejected completion retained as history. Only an explicit disclosure mounts its text. */
export function InterimReply({ message, running, workspacePath, onOpenFile, onOpenUrl }: {
  message: Message;
  running: boolean;
  workspacePath?: string | null;
  onOpenFile: TimelineProps["onOpenFile"];
  onOpenUrl: TimelineProps["onOpenUrl"];
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return <div className="interim-reply" data-history-anchor={`message:${message.id}`}>
    <button type="button" className="interim-reply-toggle" aria-expanded={open} aria-controls={bodyId}
      onClick={() => setOpen((value) => !value)}>
      <History size={13} aria-hidden="true" />
      <span>{running ? "仍在继续验证 · 中间结果" : "中间结果（已继续执行）"}</span>
      <ChevronRight className="interim-reply-chevron" size={13} aria-hidden="true" />
    </button>
    {open && <div id={bodyId} className="interim-reply-body">
      <DeepThinking text={message.reasoning} />
      <Md workspacePath={workspacePath} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl}>{message.content}</Md>
    </div>}
  </div>;
}
