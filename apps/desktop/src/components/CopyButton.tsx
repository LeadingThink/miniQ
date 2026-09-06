import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function CopyButton({
  content,
  label,
  className = "icon-button",
  onError,
}: {
  content: string;
  label: string;
  className?: string;
  onError?: (message: string) => void;
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
        title={status}
        aria-label={status}
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
      </button>
      {state === "error" && <small role="alert">复制失败</small>}
    </span>
  );
}
