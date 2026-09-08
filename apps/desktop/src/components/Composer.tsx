import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { ArrowUp, LoaderCircle, Paperclip, Sparkles, Square, X } from "lucide-react";
import { ApprovalModeSelect } from "./ApprovalModeSelect";
import {
  canSendComposer,
  isComposerSendKey,
  shouldShowComposerSend,
} from "../composerInput";
import { moveMenuIndex } from "../menuNavigation";
import type { ApprovalMode } from "../types";
import type { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import {
  containsUnsupportedInput,
  sanitizeTextInput,
} from "../textInputNavigation";
import { insertTranscript, type TextRange } from "../voiceAudio";
import { VoiceInput } from "./VoiceInput";
import { readImagePreview, savePastedImage } from "../localFiles";

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

function isImageAttachment(path: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(path);
}

function AttachmentPreview(props: {
  path: string;
  sending: boolean;
  onRemove: () => void;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const previewRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!zoomed) return;
    const closeWhenOutside = (event: PointerEvent) => {
      if (!previewRef.current?.contains(event.target as Node)) setZoomed(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomed(false);
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [zoomed]);

  useEffect(() => {
    if (!isImageAttachment(props.path)) return;
    let disposed = false;
    void readImagePreview(props.path)
      .then((preview) => {
        if (!disposed) setImageUrl(`data:${preview.mimeType};base64,${preview.dataBase64}`);
      })
      .catch(() => {
        if (!disposed) setImageUrl(null);
      });
    return () => {
      disposed = true;
    };
  }, [props.path]);

  if (imageUrl) {
    return (
      <span
        ref={previewRef}
        className={`attach-image-chip${zoomed ? " zoomed" : ""}`}
        title={props.path}
        onClick={() => setZoomed((current) => !current)}
      >
        <img src={imageUrl} alt={fileName(props.path)} className="attach-image-preview" />
        <button
          type="button"
          className="attach-remove attach-image-remove"
          title={`移除图片 ${fileName(props.path)}`}
          aria-label={`移除图片 ${fileName(props.path)}`}
          disabled={props.sending}
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove();
          }}
        >
          <X size={12} />
        </button>
      </span>
    );
  }

  return (
    <span className="attach-chip" title={props.path}>
      <Paperclip size={12} />
      {fileName(props.path)}
      <button
        type="button"
        className="attach-remove"
        title={`移除附件 ${fileName(props.path)}`}
        aria-label={`移除附件 ${fileName(props.path)}`}
        disabled={props.sending}
        onClick={props.onRemove}
      >
        <X size={11} />
      </button>
    </span>
  );
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

function readAttachments(key?: string): string[] {
  if (!key) return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(`${DRAFT_PREFIX}${key}.attachments`) ?? "[]");
    return Array.isArray(value) && value.every((path) => typeof path === "string") ? value : [];
  } catch { return []; }
}

function storeAttachments(key: string | undefined, paths: string[]) {
  if (!key) return;
  try {
    if (paths.length) window.localStorage.setItem(`${DRAFT_PREFIX}${key}.attachments`, JSON.stringify(paths));
    else window.localStorage.removeItem(`${DRAFT_PREFIX}${key}.attachments`);
  } catch { /* Draft remains in memory when browser storage is unavailable. */ }
}

type SendMessage = (content: string, attachments?: string[]) => void | boolean | Promise<void | boolean>;

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
  modelSlot?: ReactNode;
  autoFocus?: boolean;
  /** Persist unsent drafts under this key (restored on remount). */
  draftKey?: string;
  /** Replace the draft on an explicit user-selected starter action. */
  draftRequest?: { id: number; content: string };
  /** Enables `/` skill suggestions when provided. */
  client?: RpcClient;
  approvalMode?: ApprovalMode;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  onSend: SendMessage;
  onCancel?: () => void;
  onError?: (message: string) => void;
  sendBlocked?: boolean;
  sendBlockedReason?: string;
}) {
  const [draft, setDraftState] = useState(() => readDraft(props.draftKey));
  const [attachments, setAttachments] = useState<string[]>(() => readAttachments(props.draftKey));
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [dismissedSlashDraft, setDismissedSlashDraft] = useState<string | null>(null);
  const draftKeyRef = useRef(props.draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceRangeRef = useRef<TextRange>({ start: 0, end: 0 });
  const slashMenuId = useId();
  const slashActive = draft.startsWith("/") && dismissedSlashDraft !== draft;
  const slashSkills = useSlashSkills(props.client, slashActive);
  const visibleSlashSkills = filterSlashSkills(slashSkills, draft.slice(1));

  // When the draft key changes (e.g. switching sessions), load that key's draft.
  useEffect(() => {
    if (draftKeyRef.current === props.draftKey) return;
    draftKeyRef.current = props.draftKey;
    setDraftState(readDraft(props.draftKey));
    setAttachments(readAttachments(props.draftKey));
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
    if (sendingRef.current) return;
    setAttachments((current) => {
      const next = [...new Set([...current, ...paths])];
      storeAttachments(props.draftKey, next);
      return next;
    });
  }, [props.draftKey]);

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

  const pasteImages = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (sendingRef.current) return;
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (imageFiles.length === 0) return;

    event.preventDefault();
    try {
      const paths = await Promise.all(imageFiles.map((file) => savePastedImage(file)));
      addAttachments(paths);
    } catch (error) {
      props.onError?.(`无法粘贴图片: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const send = async () => {
    if (sendingRef.current || props.sendBlocked || !canSendComposer(draft, attachments)) return;
    sendingRef.current = true;
    setSending(true);
    const key = props.draftKey;
    try {
      const accepted = await props.onSend(draft.trim(), attachments);
      if (accepted === false) return;
      storeDraft(key, "");
      storeAttachments(key, []);
      if (draftKeyRef.current === key) {
        setDraftState("");
        setAttachments([]);
        setDismissedSlashDraft(null);
      }
    } catch (cause) { props.onError?.(cause instanceof Error ? cause.message : String(cause)); }
    finally { sendingRef.current = false; setSending(false); }
  };

  const pickSkill = (skill: SlashSkill) => {
    setDraft(`使用技能「${skill.name}」：`);
    setDismissedSlashDraft(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const rememberVoiceInsertion = () => {
    const textarea = textareaRef.current;
    voiceRangeRef.current = {
      start: textarea?.selectionStart ?? draft.length,
      end: textarea?.selectionEnd ?? draft.length,
    };
  };

  const applyTranscription = (text: string) => {
    let cursor = 0;
    setDraftState((current) => {
      const result = insertTranscript(current, text, voiceRangeRef.current);
      cursor = result.cursor;
      storeDraft(props.draftKey, result.value);
      return result.value;
    });
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
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
            <AttachmentPreview
              key={path}
              path={path}
              sending={sending}
              onRemove={() => setAttachments((current) => {
                const next = current.filter((p) => p !== path);
                storeAttachments(props.draftKey, next);
                return next;
              })}
            />
          ))}
        </div>
      )}
      <textarea
        readOnly={sending}
        aria-label="消息"
        ref={textareaRef}
        value={draft}
        autoFocus={props.autoFocus}
        placeholder={props.busy ? "任务执行中，发送的消息会加入队列..." : props.placeholder}
        rows={1}
        aria-autocomplete={slashActive ? "list" : undefined}
        aria-controls={slashActive ? slashMenuId : undefined}
        aria-expanded={slashActive ? visibleSlashSkills.length > 0 : undefined}
        onBeforeInput={(e) => {
          const data = (e.nativeEvent as InputEvent).data;
          if (data && containsUnsupportedInput(data)) e.preventDefault();
        }}
        onPaste={pasteImages}
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
      <div className="composer-row">
        {props.modelSlot}
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
        {props.client && (
          <VoiceInput
            client={props.client}
            onStart={rememberVoiceInsertion}
            onTranscribed={applyTranscription}
            onError={props.onError}
          />
        )}
        {props.approvalMode && props.onApprovalModeChange && (
          <ApprovalModeSelect mode={props.approvalMode} onChange={props.onApprovalModeChange} />
        )}
        {props.busy && props.onCancel && (
          <button type="button" className="send-btn stop" title="停止并清空队列 (⌘.)" onClick={props.onCancel}>
            <Square size={14} fill="currentColor" aria-label="停止任务" />
          </button>
        )}
        {shouldShowComposerSend(props.busy, draft, attachments) && (
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
            disabled={sending || props.sendBlocked || !canSendComposer(draft, attachments)}
            onClick={send}
          >
            {sending ? <LoaderCircle size={16} className="activity-spinner" aria-label="正在发送" /> : <ArrowUp size={18} aria-label="发送消息" />}
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
  modelSlot?: ReactNode;
  sendBlocked?: boolean;
  draftKey?: string;
  client?: RpcClient;
  approvalMode?: ApprovalMode;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  onSend: SendMessage;
  onCancel: () => void;
  onError?: (message: string) => void;
}) {
  return (
    <div className="composer-outer">
      <ComposerCard
        busy={props.busy}
        placeholder="随心输入,Enter 发送,/ 引用技能"
        chip={props.chip}
        modelSlot={props.modelSlot}
        sendBlocked={props.sendBlocked}
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
