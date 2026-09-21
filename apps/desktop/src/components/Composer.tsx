import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { ArrowUp, LoaderCircle, Paperclip, Square, X } from "lucide-react";
import { ApprovalModeSelect } from "./ApprovalModeSelect";
import {
  canSendComposer,
  COMPOSER_KEYBOARD_HINT,
  handleComposerKeyDown,
  shouldShowComposerSend,
} from "../composerInput";
import { useComposerSlash } from "../hooks/useComposerSlash";
import type { ComposerSlashCommand } from "../composerSlash";
import type { ApprovalMode } from "../types";
import type { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import {
  containsUnsupportedInput,
  sanitizeTextInput,
} from "../textInputNavigation";
import { insertTranscript, type TextRange } from "../voiceAudio";
import { VoiceInput } from "./VoiceInput";
import { VoiceTranscript } from "./VoiceTranscript";
import type { VoicePreview } from "../voiceTranscription";
import { readImagePreview, savePastedImage } from "../localFiles";
import { RemotePathDialog } from "./RemotePathDialog";

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
      const { getCurrentWebviewWindow } =
        await import("@tauri-apps/api/webviewWindow");
      const stop = await getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths.length > 0) {
          onFiles(event.payload.paths);
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    })().catch((error) => {
      onError?.(
        `无法接收拖入文件: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  remote?: boolean;
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
    if (props.remote || !isImageAttachment(props.path)) return;
    let disposed = false;
    void readImagePreview(props.path)
      .then((preview) => {
        if (!disposed)
          setImageUrl(`data:${preview.mimeType};base64,${preview.dataBase64}`);
      })
      .catch(() => {
        if (!disposed) setImageUrl(null);
      });
    return () => {
      disposed = true;
    };
  }, [props.path, props.remote]);

  if (imageUrl) {
    return (
      <span
        ref={previewRef}
        className={`attach-image-chip${zoomed ? " zoomed" : ""}`}
        title={props.path}
        onClick={() => setZoomed((current) => !current)}
      >
        <img
          src={imageUrl}
          alt={fileName(props.path)}
          className="attach-image-preview"
        />
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
    const value: unknown = JSON.parse(
      window.localStorage.getItem(`${DRAFT_PREFIX}${key}.attachments`) ?? "[]",
    );
    return Array.isArray(value) &&
      value.every((path) => typeof path === "string")
      ? value
      : [];
  } catch {
    return [];
  }
}

function storeAttachments(key: string | undefined, paths: string[]) {
  if (!key) return;
  try {
    if (paths.length)
      window.localStorage.setItem(
        `${DRAFT_PREFIX}${key}.attachments`,
        JSON.stringify(paths),
      );
    else window.localStorage.removeItem(`${DRAFT_PREFIX}${key}.attachments`);
  } catch {
    /* Draft remains in memory when browser storage is unavailable. */
  }
}

type SendMessage = (
  content: string,
  attachments?: string[],
) => void | boolean | Promise<void | boolean>;

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
  permissionSlot?: ReactNode;
  autoFocus?: boolean;
  /** Persist unsent drafts under this key (restored on remount). */
  draftKey?: string;
  /** Replace the draft on an explicit user-selected starter action. */
  draftRequest?: { id: number; content: string; append?: boolean };
  onDraftRequestApplied?: () => void;
  /** Load enabled skills from the current workspace. */
  client?: RpcClient;
  workspaceId?: string;
  /** Available application actions for the slash menu. */
  slashCommands?: ComposerSlashCommand[];
  approvalMode?: ApprovalMode;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  onSend: SendMessage;
  onCancel?: () => void;
  onError?: (message: string) => void;
  sendBlocked?: boolean;
  sendBlockedReason?: string;
}) {
  const keyboardHintId = useId();
  const remoteHost = props.client?.sshHost;
  const [showRemoteAttachment, setShowRemoteAttachment] = useState(false);
  const [draft, setDraftState] = useState(() => readDraft(props.draftKey));
  const draftValueRef = useRef(draft);
  draftValueRef.current = draft;
  const [attachments, setAttachments] = useState<string[]>(() =>
    readAttachments(props.draftKey),
  );
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const draftKeyRef = useRef(props.draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceRangeRef = useRef<TextRange>({ start: 0, end: 0 });
  const voiceDraftRef = useRef("");
  const [voicePreview, setVoicePreview] = useState<VoicePreview | null>(null);
  // When the draft key changes (e.g. switching sessions), load that key's draft.
  useEffect(() => {
    if (draftKeyRef.current === props.draftKey) return;
    draftKeyRef.current = props.draftKey;
    setDraftState(readDraft(props.draftKey));
    setAttachments(readAttachments(props.draftKey));
    setVoicePreview(null);
  }, [props.draftKey]);

  const setDraft = (value: string) => {
    draftValueRef.current = value;
    setDraftState(value);
    storeDraft(props.draftKey, value);
  };

  useEffect(() => {
    if (!props.draftRequest) return;
    const content =
      props.draftRequest.append && draft
        ? `${draft}\n\n${props.draftRequest.content}`
        : props.draftRequest.content;
    setDraft(content);
    props.onDraftRequestApplied?.();
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(content.length, content.length);
    }
    // The request id intentionally allows selecting the same starter twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.draftRequest?.id]);

  useLayoutEffect(() => {
    resizeComposer(textareaRef.current);
  }, [draft]);

  // A sidebar drag changes the textarea's available width without changing
  // its value. Observe that width so wrapped lines immediately update the
  // composer height and never cover the last lines of the conversation.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    let width = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      resizeComposer(textarea);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [props.draftKey]);

  const addAttachments = useCallback(
    (paths: string[]) => {
      if (sendingRef.current) return;
      setAttachments((current) => {
        const next = [...new Set([...current, ...paths])];
        storeAttachments(props.draftKey, next);
        return next;
      });
    },
    [props.draftKey],
  );

  const receiveDroppedFiles = useCallback((paths: string[]) => {
    if (remoteHost) {
      props.onError?.("当前为 SSH 会话，请先上传本机文件，再通过附件按钮填写远程文件路径。");
    } else addAttachments(paths);
  }, [addAttachments, remoteHost, props.onError]);
  useDroppedFiles(receiveDroppedFiles, props.onError);

  const pickFiles = async () => {
    if (remoteHost) { setShowRemoteAttachment(true); return; }
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

  const pasteImages = async (
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ) => {
    if (sendingRef.current) return;
    const imageFiles = Array.from(event.clipboardData.items)
      .filter(
        (item) =>
          item.kind === "file" && item.type.toLowerCase().startsWith("image/"),
      )
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (imageFiles.length === 0) return;

    event.preventDefault();
    if (remoteHost) {
      props.onError?.("当前为 SSH 会话，剪贴板图片需先上传到远程主机，再附加远程文件路径。");
      return;
    }
    try {
      const paths = await Promise.all(
        imageFiles.map((file) => savePastedImage(file)),
      );
      addAttachments(paths);
    } catch (error) {
      props.onError?.(
        `无法粘贴图片: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const send = async () => {
    if (
      sendingRef.current ||
      slash.pending ||
      voicePreview !== null ||
      props.sendBlocked ||
      !canSendComposer(draft, attachments)
    )
      return;
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
      }
    } catch (cause) {
      props.onError?.(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const slash = useComposerSlash({
    draft,
    scope: props.draftKey,
    workspaceId: props.workspaceId,
    client: props.client,
    commands: [
      ...(props.slashCommands ?? []),
      ...(isTauriRuntime()
        ? [
            {
              id: "attach",
              name: "附加文件",
              description: remoteHost ? "填写远程主机上的文件绝对路径" : "选择图片或文件作为当前消息的附件",
              group: "工具",
              icon: "file" as const,
              keywords: ["attach", "file", "附件", "文件"],
              onSelect: pickFiles,
            },
          ]
        : []),
    ],
    inputRef: textareaRef,
    setDraft,
    onPick: async (command) => {
      const key = props.draftKey;
      const previous = draft;
      const replacement = command.insertText ?? "";
      setDraft(replacement);
      try {
        await command.onSelect?.();
      } catch (cause) {
        if (
          draftKeyRef.current === key &&
          draftValueRef.current === replacement
        ) {
          setDraft(previous);
        }
        props.onError?.(cause instanceof Error ? cause.message : String(cause));
      }
      if (command.insertText !== undefined)
        requestAnimationFrame(() => textareaRef.current?.focus());
    },
  });

  const rememberVoiceInsertion = () => {
    voiceDraftRef.current = draft;
    const textarea = textareaRef.current;
    voiceRangeRef.current = {
      start: textarea?.selectionStart ?? draft.length,
      end: textarea?.selectionEnd ?? draft.length,
    };
  };

  const applyTranscription = (text: string) => {
    let cursor = 0;
    setDraftState((current) => {
      // If the user edited the draft while dictating, insert at their current
      // cursor instead of replacing a selection from an older draft.
      const position = textareaRef.current?.selectionStart ?? current.length;
      const range =
        current === voiceDraftRef.current
          ? voiceRangeRef.current
          : { start: position, end: position };
      const result = insertTranscript(current, text, range);
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
      {showRemoteAttachment && remoteHost && <RemotePathDialog host={remoteHost} purpose="attachment"
        onSubmit={async (path) => { addAttachments([path]); }} onClose={() => setShowRemoteAttachment(false)} />}
      {voicePreview && <VoiceTranscript preview={voicePreview} />}
      {slash.menu}
      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((path) => (
            <AttachmentPreview
              key={path}
              path={path}
              remote={!!remoteHost}
              sending={sending}
              onRemove={() =>
                setAttachments((current) => {
                  const next = current.filter((p) => p !== path);
                  storeAttachments(props.draftKey, next);
                  return next;
                })
              }
            />
          ))}
        </div>
      )}
      <textarea
        readOnly={sending || slash.pending}
        aria-label="消息"
        aria-describedby={keyboardHintId}
        ref={textareaRef}
        value={draft}
        autoFocus={props.autoFocus}
        placeholder={
          props.busy ? "任务执行中，发送的消息会加入队列..." : props.placeholder
        }
        rows={1}
        {...slash.inputAttributes}
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
          if (slash.onKeyDown(e)) return;
          handleComposerKeyDown(e, setDraft, () => void send());
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
            title={remoteHost ? "附加远程文件" : "附加文件(也可直接拖入窗口)"}
            onClick={() => void pickFiles()}
          >
            <Paperclip size={15} />
          </button>
        )}
        {props.client && (
          <VoiceInput
            key={props.draftKey}
            client={props.client}
            disabled={sending || slash.pending}
            onStart={rememberVoiceInsertion}
            onTranscribed={applyTranscription}
            onPreview={setVoicePreview}
            onError={props.onError}
          />
        )}
        {props.approvalMode && props.onApprovalModeChange && (
          <ApprovalModeSelect
            mode={props.approvalMode}
            onChange={props.onApprovalModeChange}
          />
        )}
        {props.permissionSlot}
        {props.busy && props.onCancel && (
          <button
            type="button"
            className="send-btn stop"
            title="停止并清空队列 (⌘.)"
            onClick={props.onCancel}
          >
            <Square size={14} fill="currentColor" aria-label="停止任务" />
          </button>
        )}
        {shouldShowComposerSend(props.busy, draft, attachments) && (
          <button
            type="button"
            className="send-btn"
            title={
              props.sendBlocked
                ? (props.sendBlockedReason ?? "当前无法发送")
                : props.busy
                  ? "加入队列，当前任务结束后执行"
                  : "发送"
            }
            disabled={
              sending ||
              slash.pending ||
              voicePreview !== null ||
              props.sendBlocked ||
              !canSendComposer(draft, attachments)
            }
            onClick={send}
          >
            {sending ? (
              <LoaderCircle
                size={16}
                className="activity-spinner"
                aria-label="正在发送"
              />
            ) : (
              <ArrowUp size={18} aria-label="发送消息" />
            )}
          </button>
        )}
      </div>
      <p id={keyboardHintId} className="composer-keyboard-hint">
        {COMPOSER_KEYBOARD_HINT}
      </p>
    </div>
  );
}

/** Bottom-docked composer for an open session. */
export function Composer(props: {
  busy: boolean;
  chip?: string;
  modelSlot?: ReactNode;
  permissionSlot?: ReactNode;
  sendBlocked?: boolean;
  draftKey?: string;
  draftRequest?: { id: number; content: string; append?: boolean };
  onDraftRequestApplied?: () => void;
  client?: RpcClient;
  workspaceId?: string;
  slashCommands?: ComposerSlashCommand[];
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
        placeholder="随心输入，/ 使用命令与技能"
        chip={props.chip}
        modelSlot={props.modelSlot}
        permissionSlot={props.permissionSlot}
        sendBlocked={props.sendBlocked}
        draftKey={props.draftKey}
        draftRequest={props.draftRequest}
        onDraftRequestApplied={props.onDraftRequestApplied}
        client={props.client}
        workspaceId={props.workspaceId}
        slashCommands={props.slashCommands}
        approvalMode={props.approvalMode}
        onApprovalModeChange={props.onApprovalModeChange}
        onSend={props.onSend}
        onCancel={props.onCancel}
        onError={props.onError}
      />
    </div>
  );
}
