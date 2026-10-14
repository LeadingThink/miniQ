import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  EFFORT_LABELS,
  type ModelDescription,
  type ReasoningEffort,
} from "../modelSelection";
import { MenuSelect } from "./MenuSelect";
import { Popover } from "./ui/Popover";
import "./SessionReasoningControl.css";

export function SessionReasoningControl({
  description,
  error,
  value,
  disabled,
  onChange,
  onRetry,
}: {
  description: ModelDescription | null;
  error: string | null;
  value: ReasoningEffort | null;
  disabled: boolean;
  onChange: (effort: ReasoningEffort | null) => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (description?.reasoningEfforts.length) setOpen(false);
  }, [description]);
  if (description?.reasoningEfforts.length) {
    return (
      <MenuSelect<ReasoningEffort | "">
        menuLabel="会话推理强度"
        title="推理强度"
        disabled={disabled}
        value={value ?? ""}
        options={[
          { value: "", label: "默认推理" },
          ...description.reasoningEfforts.map((effort) => ({
            value: effort,
            label: EFFORT_LABELS[effort],
          })),
        ]}
        onChange={(effort) => onChange(effort || null)}
      />
    );
  }
  return (
    <div className="mode-select">
      <button
        ref={trigger}
        type="button"
        className="mode-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="查看推理设置说明"
        onClick={() => setOpen((current) => !current)}
      >
        {error ? "读取失败" : description ? "默认推理" : "读取中"}
        <ChevronDown className="mode-caret" />
      </button>
      <Popover
        open={open}
        anchorRef={trigger}
        onClose={close}
        label="推理设置说明"
        className="reasoning-info-popover"
      >
        <strong>推理设置</strong>
        {error ? (
          <>
            <p role="alert">未能读取模型的推理选项，请重试。</p>
            <button type="button" className="secondary" onClick={onRetry}>
              重新读取推理选项
            </button>
          </>
        ) : (
          <p role="status">
            {description
              ? "当前模型未提供可选的推理强度，使用模型默认设置。切换到提供推理档位的模型后即可选择。"
              : "正在读取当前模型的推理选项…"}
          </p>
        )}
      </Popover>
    </div>
  );
}
