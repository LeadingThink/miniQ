import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Paperclip, Sparkles, X } from "lucide-react";
import { ApprovalModeSelect } from "./ApprovalModeSelect";
import {
  buildComposerMessage,
  canSendComposer,
  isComposerSendKey,
} from "../composerInput";
import { moveMenuIndex } from "../menuNavigation";
import type { ApprovalMode, ImageAttachment, UserMessageInput } from "../types";
import type { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import {
  containsUnsupportedInput,
  sanitizeTextInput,
} from "../textInputNavigation";

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

/** Listen for native file drops (Tauri window-level drag & drop). */
function useDroppedFiles(
  onFiles: (paths: string[]) => void,
  onError?: (message: string) => void,
) {
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWebviewWindow } = await import(
        "@tauri-apps/api/webviewWindow"
      );
      const stop = await getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths.length > 0) {
          onFiles(event.payload.paths);
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    })().catch((error) => {
      onError?.(`无法接收拖入文件: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onError, onFiles]);
}

function fileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

const DRAFT_PREFIX = "miniq.draft.";

function readDraft(key: string | undefined): string {
  if (!key) return "";
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

function storeDraft(key: string | undefined, value: string) {
  if (!key) return;
  try {
    if (value) window.localStorage.setItem(DRAFT_PREFIX + key, value);
    else window.localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* storage unavailable */
  }
}

interface SlashSkill {
  name: string;
  description: string;
  enabled: boolean;
}

/** Slash-command suggestions: type `/` to reference an enabled skill. */
function useSlashSkills(client: RpcClient | undefined, active: boolean) {
  const [skills, setSkills] = useState<SlashSkill[]>([]);
  useEffect(() => {
    if (!active || !client) return;
    let stale = false;
    client
      .call<{ skills: SlashSkill[] }>("skill.list", {})
      .then((result) => {
        if (!stale) setSkills(result.skills.filter((s) => s.enabled));
      })
      .catch(() => {
        if (!stale) setSkills([]);
      });
    return () => {
      stale = true;
    };
  }, [active, client]);
  return skills;
}

function SlashMenu(props: {
  id: string;
  skills: SlashSkill[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onPick: (skill: SlashSkill) => void;
}) {
  if (props.skills.length === 0) return null;
  return (
    <div id={props.id} className="slash-menu" role="listbox" aria-label="可用技能">
      <div className="slash-title">技能</div>
      {props.skills.map((skill, index) => (
        <button
          key={skill.name}
          type="button"
          role="option"
          aria-selected={index === props.activeIndex}
          className={`slash-item${index === props.activeIndex ? " active" : ""}`}
          onMouseEnter={() => props.onActiveIndexChange(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onPick(skill)}
        >
          <Sparkles size={13} />
          <span className="slash-name">{skill.name}</span>
          <span className="slash-desc">{skill.description}</span>
        </button>
      ))}
    </div>
  );
}

function filterSlashSkills(skills: SlashSkill[], query: string): SlashSkill[] {
  const normalized = query.trim().toLowerCase();
  return skills
    .filter((skill) => skill.name.toLowerCase().includes(normalized))
    .slice(0, 8);
}

function resizeComposer(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
}

/** Rounded composer card: textarea + context chip row + circular send. */
export function ComposerCard(props: {
  busy: boolean;
  placeholder: string;
  chip?: string;
  /** Custom leading element in the bottom row (e.g. a project picker). */
  chipSlot?: ReactNode;
  autoFocus?: boolean;
  /** Persist unsent drafts under this key (restored on remount). */
  draftKey?: string;
  /** Replace the draft on an explicit user-selected starter action. */
  draftRequest?: { id: number; content: string };
  /** Enables `/` skill suggestions when provided. */
  client?: RpcClient;
  approvalMode?: ApprovalMode;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  onSend: (message: UserMessageInput) => void;
  onCancel?: () => void;
  onError?: (message: string) => void;
  sendBlocked?: boolean;
  sendBlockedReason?: string;
}) {
  const [draft, setDraftState] = useState(() => readDraft(props.draftKey));
  const [attachments, setAttachments] = useState<string[]>([]);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [dismissedSlashDraft, setDismissedSlashDraft] = useState<string | null>(null);
  const draftKeyRef = useRef(props.draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashMenuId = useId();
  const slashActive = draft.startsWith("/") && dismissedSlashDraft !== draft;
  const slashSkills = useSlashSkills(props.client, slashActive);
  const visibleSlashSkills = filterSlashSkills(slashSkills, draft.slice(1));

  // When the draft key changes (e.g. switching sessions), load that key's draft.
  useEffect(() => {
    if (draftKeyRef.current === props.draftKey) return;
    draftKeyRef.current = props.draftKey;
    setDraftState(readDraft(props.draftKey));
    setAttachments([]);
    setImages([]);
    setImageError(null);
    setDismissedSlashDraft(null);
  }, [props.draftKey]);

  const setDraft = (value: string) => {
    setDraftState(value);
    storeDraft(props.draftKey, value);
  };

  useEffect(() => {
    if (!props.draftRequest) return;
    setDraft(props.draftRequest.content);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(
        props.draftRequest.content.length,
        props.draftRequest.content.length,
      );
    }
    // The request id intentionally allows selecting the same starter twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.draftRequest?.id]);

  useLayoutEffect(() => {
    resizeComposer(textareaRef.current);
  }, [draft]);

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [draft]);

  const addAttachments = useCallback((paths: string[]) => {
    setAttachments((current) => [
      ...current,
      ...paths.filter((path) => !current.includes(path)),
    ]);
  }, []);

  useDroppedFiles(addAttachments, props.onError);

  const pickFiles = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true, title: "附加文件" });
      if (Array.isArray(selected)) addAttachments(selected);
      else if (typeof selected === "string") addAttachments([selected]);
    } catch (error) {
      props.onError?.(
        `无法选择附件: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const send = () => {
    if (props.sendBlocked || !canSendComposer(draft, attachments, images)) return;
    props.onSend(buildComposerMessage(draft, attachments, images));
    setDraft("");
    setAttachments([]);
    setImages([]);
    setImageError(null);
    setDismissedSlashDraft(null);
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

  const pickSkill = (skill: SlashSkill) => {
    setDraft(`使用技能「${skill.name}」：`);
    setDismissedSlashDraft(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div className="composer-card">
      {slashActive && (
        <SlashMenu
          id={slashMenuId}
          skills={visibleSlashSkills}
          activeIndex={activeSkillIndex}
          onActiveIndexChange={setActiveSkillIndex}
          onPick={pickSkill}
        />
      )}
      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((path) => (
            <span className="attach-chip" key={path} title={path}>
              <Paperclip size={12} />
              {fileName(path)}
              <button
                type="button"
                className="attach-remove"
                title={`移除附件 ${fileName(path)}`}
                aria-label={`移除附件 ${fileName(path)}`}
                onClick={() =>
                  setAttachments((current) => current.filter((p) => p !== path))
                }
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={draft}
        autoFocus={props.autoFocus}
        placeholder={props.busy ? "任务执行中，发送的消息会加入队列..." : props.placeholder}
        rows={1}
        onPaste={onPaste}
        aria-autocomplete={slashActive ? "list" : undefined}
        aria-controls={slashActive ? slashMenuId : undefined}
        aria-expanded={slashActive ? visibleSlashSkills.length > 0 : undefined}
        onBeforeInput={(e) => {
          const data = (e.nativeEvent as InputEvent).data;
          if (data && containsUnsupportedInput(data)) e.preventDefault();
        }}
        onChange={(e) => {
          const textarea = e.currentTarget;
          const sanitized = sanitizeTextInput(
            textarea.value,
            textarea.selectionStart,
            textarea.selectionEnd,
          );
          setDraft(sanitized.value);
          if (sanitized.changed) {
            requestAnimationFrame(() => {
              textarea.setSelectionRange(sanitized.start, sanitized.end);
            });
          }
        }}
        onKeyDown={(e) => {
          if (slashActive && visibleSlashSkills.length > 0) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActiveSkillIndex((index) =>
                moveMenuIndex(
                  index,
                  visibleSlashSkills.length,
                  e.key === "ArrowDown" ? 1 : -1,
                ),
              );
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
              e.preventDefault();
              pickSkill(visibleSlashSkills[activeSkillIndex] ?? visibleSlashSkills[0]);
              return;
            }
          }
          if (e.key === "Escape" && slashActive) {
            e.preventDefault();
            setDismissedSlashDraft(draft);
            return;
          }
          if (
            isComposerSendKey(
              e.key,
              e.shiftKey,
              e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229,
            )
          ) {
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
        {isTauriRuntime() && (
          <button
            type="button"
            className="attach-btn"
            title="附加文件(也可直接拖入窗口)"
            onClick={() => void pickFiles()}
          >
            <Paperclip size={15} />
          </button>
        )}
        {props.approvalMode && props.onApprovalModeChange && (
          <ApprovalModeSelect mode={props.approvalMode} onChange={props.onApprovalModeChange} />
        )}
        {props.busy && props.onCancel && (
          <button type="button" className="send-btn stop" title="停止并清空队列 (⌘.)" onClick={props.onCancel}>
            ■
          </button>
        )}
        <button
          type="button"
          className="send-btn"
          title={
            props.sendBlocked
              ? props.sendBlockedReason ?? "当前无法发送"
              : props.busy
                ? "加入队列，当前任务结束后执行"
                : "发送"
          }
          disabled={props.sendBlocked || !canSendComposer(draft, attachments, images)}
          onClick={send}
        >
          ↑
        </button>
      </div>
    </div>
  );
}

/** Bottom-docked composer for an open session. */
export function Composer(props: {
  busy: boolean;
  chip?: string;
  draftKey?: string;
  client?: RpcClient;
  approvalMode?: ApprovalMode;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  onSend: (message: UserMessageInput) => void;
  onCancel: () => void;
  onError?: (message: string) => void;
}) {
  return (
    <div className="composer-outer">
      <ComposerCard
        busy={props.busy}
        placeholder="随心输入,Enter 发送,/ 引用技能"
        chip={props.chip}
        draftKey={props.draftKey}
        client={props.client}
        approvalMode={props.approvalMode}
        onApprovalModeChange={props.onApprovalModeChange}
        onSend={props.onSend}
        onCancel={props.onCancel}
        onError={props.onError}
      />
    </div>
  );
}
