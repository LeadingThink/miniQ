import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ApprovalMode, ImageAttachment, UserMessageInput } from "../types";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取图片 ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error(`无法解析图片 ${file.name}`));
        return;
      }
      resolve({ mediaType: file.type, data: result.slice(comma + 1) });
    };
    reader.readAsDataURL(file);
  });
}

function imageUrl(image: ImageAttachment) {
  return `data:${image.mediaType};base64,${image.data}`;
}

/** Monochrome line icons (stroke = currentColor), Codex-style. */
function HandIcon() {
  return (
    <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6.5a1.5 1.5 0 0 0-3 0V11m0-5.5v-1a1.5 1.5 0 0 0-3 0V11m0-6.5a1.5 1.5 0 0 0-3 0V12m-3-4a1.5 1.5 0 0 1 3 0v6l-1.8-1.2a1.6 1.6 0 0 0-2 2.5l4.3 4.7a5 5 0 0 0 3.7 1.6h1.9a5 5 0 0 0 5-5V11" />
    </svg>
  );
}

function ApproveIcon() {
  return (
    <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7.5 12 3 3 6-6" />
    </svg>
  );
}

function FullAccessIcon() {
  return (
    <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V13" />
      <circle cx="12" cy="16.5" r="0.4" fill="currentColor" />
    </svg>
  );
}

const MODE_LABELS: Record<
  ApprovalMode,
  { label: string; icon: () => JSX.Element; desc: string }
> = {
  alwaysAsk: {
    label: "请求批准",
    icon: HandIcon,
    desc: "修改文件和使用网络等操作每次都询问",
  },
  auto: {
    label: "替我审批",
    icon: ApproveIcon,
    desc: "常规操作自动执行,联网访问和危险命令等高风险操作才询问",
  },
  fullAccess: {
    label: "完全访问",
    icon: FullAccessIcon,
    desc: "不受限制地执行所有操作,仅拦截越界访问",
  },
};

/** Dropdown for choosing how risky tool calls are approved. */
function ModeSelect(props: {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const current = MODE_LABELS[props.mode] ?? MODE_LABELS.auto;
  const CurrentIcon = current.icon;
  return (
    <div className="mode-select" ref={ref}>
      <button
        className={`mode-trigger ${props.mode === "fullAccess" ? "warn" : ""}`}
        title={current.desc}
        onClick={() => setOpen((v) => !v)}
      >
        <CurrentIcon />
        {current.label}
        <svg className="mode-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="mode-menu">
          {(Object.keys(MODE_LABELS) as ApprovalMode[]).map((mode) => {
            const Icon = MODE_LABELS[mode].icon;
            return (
              <div
                key={mode}
                className={`mode-item ${mode === props.mode ? "active" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (mode !== props.mode) props.onChange(mode);
                }}
              >
                <div className="mode-item-label">
                  <Icon />
                  {MODE_LABELS[mode].label}
                  {mode === props.mode && (
                    <svg className="mode-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m5 13 4 4L19 7" />
                    </svg>
                  )}
                </div>
                <div className="mode-item-desc">{MODE_LABELS[mode].desc}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Rounded composer card: textarea + context chip row + circular send. */
export function ComposerCard(props: {
  busy: boolean;
  placeholder: string;
  chip?: string;
  /** Custom leading element in the bottom row (e.g. a project picker). */
  chipSlot?: ReactNode;
  autoFocus?: boolean;
  approvalMode?: ApprovalMode;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  onSend: (message: UserMessageInput) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);

  const send = () => {
    const content = draft.trim();
    if ((!content && images.length === 0) || props.busy) return;
    props.onSend({ content, images });
    setDraft("");
    setImages([]);
    setImageError(null);
  };

  const onPaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    event.preventDefault();

    const accepted = files
      .filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type) && file.size <= MAX_IMAGE_BYTES)
      .slice(0, MAX_IMAGES - images.length);
    if (accepted.length !== files.length) {
      setImageError("最多粘贴 4 张图片，单张不超过 10 MiB，支持 PNG、JPEG、WebP 和 GIF");
    } else {
      setImageError(null);
    }
    if (accepted.length === 0) return;

    try {
      const added = await Promise.all(accepted.map(readImage));
      setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "无法读取粘贴的图片");
    }
  };

  return (
    <div className="composer-card">
      <textarea
        value={draft}
        autoFocus={props.autoFocus}
        placeholder={props.busy ? "任务执行中..." : props.placeholder}
        rows={1}
        onPaste={onPaste}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((image, index) => (
            <div className="composer-image" key={`${image.data.slice(0, 24)}-${index}`}>
              <img src={imageUrl(image)} alt={`粘贴的图片 ${index + 1}`} />
              <button
                type="button"
                title="移除图片"
                aria-label={`移除图片 ${index + 1}`}
                onClick={() => setImages((current) => current.filter((_, item) => item !== index))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {imageError && <div className="composer-image-error">{imageError}</div>}
      <div className="composer-row">
        {props.chipSlot}
        {props.chip && <span className="chip">🗂 {props.chip}</span>}
        {props.approvalMode && props.onApprovalModeChange && (
          <ModeSelect mode={props.approvalMode} onChange={props.onApprovalModeChange} />
        )}
        {props.busy && props.onCancel ? (
          <button className="send-btn stop" title="取消" onClick={props.onCancel}>
            ■
          </button>
        ) : (
          <button
            className="send-btn"
            title="发送"
            disabled={!draft.trim() && images.length === 0}
            onClick={send}
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}

/** Bottom-docked composer for an open session. */
export function Composer(props: {
  busy: boolean;
  chip?: string;
  approvalMode?: ApprovalMode;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  onSend: (message: UserMessageInput) => void;
  onCancel: () => void;
}) {
  return (
    <div className="composer-outer">
      <ComposerCard
        busy={props.busy}
        placeholder="随心输入,Enter 发送"
        chip={props.chip}
        approvalMode={props.approvalMode}
        onApprovalModeChange={props.onApprovalModeChange}
        onSend={props.onSend}
        onCancel={props.onCancel}
      />
    </div>
  );
}
