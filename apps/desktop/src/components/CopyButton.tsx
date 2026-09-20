import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function CopyButton({
  content,
  label,
  className = "icon-button",
  onError,
  showLabel = false,
  disabled = false,
}: {
  content: string;
  label: string;
  className?: string;
  onError?: (message: string) => void;
  showLabel?: boolean;
  disabled?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const status =
    state === "copied" ? "已复制" : state === "error" ? "复制失败" : label;
  return (
    <span className="copy-control">
      <button
        type="button"
        className={`${className} ${state}`}
        title={disabled ? "没有可复制的文字" : status}
        aria-label={status}
        disabled={disabled}
        onClick={() => {
          void (async () => {
            try {
              await navigator.clipboard.writeText(content);
              if (!mounted.current) return;
              setState("copied");
            } catch {
              if (!mounted.current) return;
              setState("error");
              onError?.("无法访问剪贴板");
            }
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setState("idle"), 1800);
          })();
        }}
      >
        {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
        {showLabel && <span>{status}</span>}
      </button>
      {state === "error" && <small role="alert">复制失败</small>}
    </span>
  );
}
