import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ComponentProps, ReactNode } from "react";
import { ArrowUp, LoaderCircle, Paperclip, Square } from "lucide-react";
import { ApprovalModeSelect } from "./ApprovalModeSelect";
import {
  canSendComposer,
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
import { savePastedImage } from "../localFiles";
import { readDraft, storeDraft, readAttachments, storeAttachments } from "../composerDraft";
import { AttachmentPreview } from "./AttachmentPreview";
import { RemotePathDialog } from "./RemotePathDialog";
import { useTouchComposerInput } from "../hooks/useTouchComposerInput";
import { useDroppedFiles } from "../hooks/useDroppedFiles";
import { useAttachmentReads } from "../hooks/useAttachmentReads";
import "./Composer.css";



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
  const inputMode = useTouchComposerInput();
  const attachmentReads = useAttachmentReads(props.draftKey);
  const remoteHost = props.client?.sshHost || (props.client?.mode === "remote" ? "远程电脑" : null);
  const canAttach = isTauriRuntime() || !!remoteHost;
  const [showRemoteAttachment, setShowRemoteAttachment] = useState(false);
  const [draft, setDraftState] = useState(() => readDraft(props.draftKey));
  const draftValueRef = useRef(draft);
  draftValueRef.current = draft;
  const [attachments, setAttachments] = useState<string[]>(() =>
    readAttachments(props.draftKey),
  );
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);
  const draftKeyRef = useRef(props.draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceRangeRef = useRef<TextRange>({ start: 0, end: 0 });
  const voiceDraftRef = useRef("");
  const [voicePreview, setVoicePreview] = useState<VoicePreview | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // When the draft key changes (e.g. switching sessions), load that key's draft.
  useEffect(() => {
    if (draftKeyRef.current === props.draftKey) return;
    draftKeyRef.current = props.draftKey;
    setDraftState(readDraft(props.draftKey));
    setAttachments(readAttachments(props.draftKey));
    setVoicePreview(null);
    setShowRemoteAttachment(false);
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
      // Native pickers and clipboard saves may finish after switching sessions.
      // Keep the result with the draft which initiated that operation.
      if (!mountedRef.current || draftKeyRef.current !== props.draftKey) {
        storeAttachments(props.draftKey, [...new Set([...readAttachments(props.draftKey), ...paths])]);
        return;
      }
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
      props.onError?.("当前连接远程电脑，请先将文件传到该电脑，再通过附件按钮填写文件路径。");
    } else addAttachments(paths);
  }, [addAttachments, remoteHost, props.onError]);
  useDroppedFiles(receiveDroppedFiles, props.onError);

  const pickFiles = async () => {
    if (remoteHost) { setShowRemoteAttachment(true); return; }
    try {
      const selected = await attachmentReads.run(async () => {
        const { open } = await import("@tauri-apps/plugin-dialog");
        return open({ multiple: true, title: "附加文件" });
      });
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
      props.onError?.("当前连接远程电脑，剪贴板图片需先传到该电脑，再附加远程文件路径。");
      return;
    }
    try {
      const paths = await attachmentReads.run(() => Promise.all(imageFiles.map((file) => savePastedImage(file))));
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
      attachmentReads.hasPending() ||
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
      ...(canAttach
        ? [
            {
              id: "attach",
              name: "附加文件",
              description: remoteHost ? "附加远程电脑上已有的文件" : "选择图片或文件作为当前消息的附件",
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
        enterKeyHint={inputMode.enterSends ? "send" : "enter"}
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
          handleComposerKeyDown(e, setDraft, () => void send(), inputMode);
        }}
      />
      <div className="composer-row">
        {props.modelSlot}
        {props.chipSlot}
        {props.chip && <span className="chip">🗂 {props.chip}</span>}
        {canAttach && (
          <button
            type="button"
            className="attach-btn"
            title={remoteHost ? "附加远程文件" : "附加文件(也可直接拖入窗口)"}
            aria-label={remoteHost ? "附加远程文件" : "附加文件"}
            disabled={sending || slash.pending}
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
              attachmentReads.pending ||
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
      {attachmentReads.pending && <p className="composer-send-status" role="status">正在准备附件，完成后可发送</p>}
      {props.sendBlocked && <p className="composer-send-status" role="status">
        {props.sendBlockedReason ?? "暂时无法发送，草稿会保留"}
      </p>}
      <p id={keyboardHintId} className="composer-keyboard-hint">
        {inputMode.keyboardHint}
      </p>
    </div>
  );
}

/** Bottom-docked composer for an open session. */
export function Composer(props: Omit<ComponentProps<typeof ComposerCard>, "placeholder" | "autoFocus" | "chipSlot"> & { onCancel: () => void }) {
  return (
    <div className="composer-outer">
      <ComposerCard
        {...props}
        placeholder="随心输入，/ 使用命令与技能"
      />
    </div>
  );
}
