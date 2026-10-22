import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ComponentProps, ReactNode } from "react";
import { ArrowUp, Folder, LoaderCircle, Paperclip, Plus, Slash, Square, Target } from "lucide-react";
import { ApprovalModeSelect } from "./ApprovalModeSelect";
import {
  COMPOSER_PLACEHOLDER,
  MAX_COMPOSER_ATTACHMENTS,
  canSendComposer,
  shouldShowComposerSend,
} from "../composerInput";
import {
  activeTextarea,
  fieldTextareas,
  focusTextarea,
  handleComposerFieldKey,
  placeComposerCaret,
  readComposerCaret,
  readComposerValue,
} from "../composerField";
import { useComposerSlash } from "../hooks/useComposerSlash";
import { useComposerMention } from "../hooks/useComposerMention";
import { useComposerInsert } from "../hooks/useComposerInsert";
import { insertComposerText } from "../composerMention";
import type { ComposerSlashCommand } from "../composerSlash";
import type { ApprovalMode, Message } from "../types";
import type { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import {
  containsUnsupportedInput,
  sanitizeTextInput,
} from "../textInputNavigation";
import { insertTranscript, type TextRange } from "../voiceAudio";
import { VoiceInput } from "./VoiceInput";
import { useSpeechInput } from "../useSpeechInput";
import { VoiceTranscript } from "./VoiceTranscript";
import type { VoicePreview } from "../voiceTranscription";
import { savePastedFile } from "../localFiles";
import { clipboardFiles } from "../clipboardFiles";
import { readDraft, storeDraft, readAttachments, storeAttachments, readPastes, storePastes } from "../composerDraft";
import { expandPastes, isLargePaste, nextPlaceholder, type PendingPaste } from "../largePaste";
import { ComposerField as ComposerFieldView } from "./ComposerField";
import { AttachmentPreview } from "./AttachmentPreview";
import { RemotePathDialog } from "./RemotePathDialog";
import { ComposerRemoteUpload } from "./ComposerRemoteUpload";
import type { RemoteUploadScope } from "../remoteTransfer";
import { useTouchComposerInput } from "../hooks/useTouchComposerInput";
import { useDroppedFiles } from "../hooks/useDroppedFiles";
import { usePastedInput } from "../hooks/usePastedInput";
import { useAttachmentReads } from "../hooks/useAttachmentReads";
import "./Composer.css";



type SendMessage = (
  content: string,
  attachments?: string[],
  asGoal?: boolean,
) => void | boolean | Promise<void | boolean>;

/** Writes one segment back into the combined draft without touching chips. */
function replaceSegment(field: HTMLElement | null, area: HTMLTextAreaElement, next: string): string {
  if (!field) return next;
  let value = "";
  for (const node of field.childNodes) {
    if (node === area) value += next;
    else if (node instanceof HTMLTextAreaElement) value += node.value;
    else if (node instanceof HTMLElement && node.dataset.placeholder)
      value += node.dataset.placeholder;
  }
  return value;
}

function resizeComposer(field: HTMLElement | null) {
  const areas = fieldTextareas(field);
  if (areas.length === 0) return;
  if (areas.length === 1) {
    const textarea = areas[0];
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    return;
  }
  for (const textarea of areas) textarea.style.height = "auto";
}

/** Unique attachment paths in order, capped at the limit the daemon enforces. */
function mergeAttachments(
  current: readonly string[],
  incoming: readonly string[],
): { paths: string[]; dropped: number } {
  const unique = [...new Set([...current, ...incoming])];
  return {
    paths: unique.slice(0, MAX_COMPOSER_ATTACHMENTS),
    dropped: Math.max(0, unique.length - MAX_COMPOSER_ATTACHMENTS),
  };
}

function attachmentLimitMessage(dropped: number): string {
  return `每条消息最多附加 ${MAX_COMPOSER_ATTACHMENTS} 个文件，${dropped} 个未添加`;
}

/** Rounded composer card: textarea + context chip row + circular send. */
export function ComposerCard(props: {
  busy: boolean;
  placeholder: string;
  chip?: string;
  /** Project context displayed above the input, alongside approval controls. */
  chipSlot?: ReactNode;
  /** Queued messages docked onto the card's top edge, above the input. */
  queueSlot?: ReactNode;
  modelSlot?: ReactNode;
  permissionSlot?: ReactNode;
  allowGoal?: boolean;
  autoFocus?: boolean;
  /** Explicit companion navigation focuses the existing control; it never starts recording. */
  voiceFocusRequest?: number;
  onVoiceFocusApplied?: (id: number) => void;
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
  /** Current session: enables `@` file mentions from its project folder. */
  sessionId?: string;
  /** This session's messages: ↑ in an empty input recalls the last user one. */
  messages?: Message[];
}) {
  const card = useRef<HTMLDivElement>(null);
  const focusedVoiceRequest = useRef<number | undefined>(undefined);
  const keyboardHintId = useId();
  const inputMode = useTouchComposerInput();
  const attachmentReads = useAttachmentReads(props.draftKey);
  const remoteHost = props.client?.sshHost || (props.client?.mode === "remote" ? "远程电脑" : null);
  // An existing session wins; before one exists the chosen project scopes uploads.
  const remoteUploadScope: RemoteUploadScope | undefined = props.sessionId ? { sessionId: props.sessionId }
    : props.workspaceId ? { workspaceId: props.workspaceId } : undefined;
  const remoteUploadKey = props.sessionId ? `session:${props.sessionId}` : props.workspaceId ? `workspace:${props.workspaceId}` : "";
  const uploadScope = useRef({ client: props.client, scopeKey: remoteUploadKey, draftKey: props.draftKey });
  uploadScope.current = { client: props.client, scopeKey: remoteUploadKey, draftKey: props.draftKey };
  const canAttach = isTauriRuntime() || !!remoteHost;
  const [showRemoteAttachment, setShowRemoteAttachment] = useState(false);
  const [draft, setDraftState] = useState(() => readDraft(props.draftKey));
  const [caret, setCaret] = useState(-1);
  // Caret requested by programmatic edits (mention pick, insert bus); applied
  // after React commits the new value so it is not reset to the end.
  const pendingCaretRef = useRef<number | null>(null);
  const placeCaret = (cursor: number) => {
    pendingCaretRef.current = cursor;
    setCaret(cursor);
  };
  useLayoutEffect(() => {
    const cursor = pendingCaretRef.current;
    if (cursor === null) return;
    pendingCaretRef.current = null;
    placeComposerCaret(fieldRef.current, cursor);
  });
  const draftValueRef = useRef(draft);
  draftValueRef.current = draft;
  const [attachments, setAttachments] = useState<string[]>(() =>
    readAttachments(props.draftKey),
  );
  const attachmentsRef = useRef(attachments);
  // Collapsed pastes render as inline chips and follow the draft that owns them.
  const [pastes, setPastes] = useState(() => readPastes(props.draftKey));
  const pastesRef = useRef(pastes);
  pastesRef.current = pastes;
  const [sending, setSending] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);
  const draftKeyRef = useRef(props.draftKey);
  const fieldRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLElement | null>(null);
  const syncTextarea = () => {
    textareaRef.current = fieldRef.current;
  };
  const voiceRangeRef = useRef<TextRange>({ start: 0, end: 0 });
  const voiceDraftRef = useRef("");
  const [voicePreview, setVoicePreview] = useState<VoicePreview | null>(null);
  const voiceCapabilities = useSpeechInput(props.client);
  // Secondary inputs live behind "+". The panel stays mounted so an active
  // voice recording keeps its state, and it is forced open while voice is live.
  const [plusOpen, setPlusOpen] = useState(false);
  const plusRef = useRef<HTMLDivElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const plusPanelId = useId();
  // Keep the mic beside send on every form factor so dictation stays a first-level action.
  const plusVisible = plusOpen;
  useEffect(() => {
    if (!plusOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!plusRef.current?.contains(event.target as Node)) setPlusOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPlusOpen(false);
      plusButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [plusOpen]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // When the draft key changes (e.g. switching sessions), load that key's draft.
  useEffect(() => {
    if (draftKeyRef.current === props.draftKey) return;
    draftKeyRef.current = props.draftKey;
    setDraftState(readDraft(props.draftKey));
    attachmentsRef.current = readAttachments(props.draftKey);
    setAttachments(attachmentsRef.current);
    setPastes(readPastes(props.draftKey));
    setGoalMode(false);
    setVoicePreview(null);
    setShowRemoteAttachment(false);
  }, [props.draftKey]);

  useEffect(() => { setShowRemoteAttachment(false); }, [props.client, remoteUploadKey]);

  /** One writer for the attachment list so the ref never drifts from the draft. */
  const applyAttachments = (next: string[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
    storeAttachments(props.draftKey, next);
  };

  /** A collapsed paste is stored with the draft that shows its chip. */
  const applyPastes = (next: PendingPaste[]) => {
    pastesRef.current = next;
    setPastes(next);
    storePastes(props.draftKey, next);
  };

  const setDraft = (value: string) => {
    draftValueRef.current = value;
    setDraftState(value);
    storeDraft(props.draftKey, value);
    // Deleting a placeholder deletes the text it hides; nothing is orphaned.
    if (pastesRef.current.length === 0) return;
    const kept = pastesRef.current.filter((paste) => value.includes(paste.placeholder));
    if (kept.length !== pastesRef.current.length) applyPastes(kept);
  };

  useEffect(() => {
    if (!props.draftRequest) return;
    const content =
      props.draftRequest.append && draft
        ? `${draft}\n\n${props.draftRequest.content}`
        : props.draftRequest.content;
    setDraft(content);
    props.onDraftRequestApplied?.();
    // The starter button keeps document focus. Move the caret into the draft.
    placeCaret(content.length);
    // The request id intentionally allows selecting the same starter twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.draftRequest?.id]);

  useLayoutEffect(() => {
    syncTextarea();
    resizeComposer(fieldRef.current);
  });

  // A sidebar drag changes the textarea's available width without changing
  // its value. Observe that width so wrapped lines immediately update the
  // composer height and never cover the last lines of the conversation.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field || typeof ResizeObserver === "undefined") return;
    let width = field.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = field.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      resizeComposer(field);
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [props.draftKey]);

  const addAttachments = (paths: string[]) => {
    // Native pickers and clipboard saves may finish after switching sessions.
    // Keep the result with the draft which initiated that operation.
    if (!mountedRef.current || draftKeyRef.current !== props.draftKey) {
      storeAttachments(props.draftKey, mergeAttachments(readAttachments(props.draftKey), paths).paths);
      return;
    }
    if (sendingRef.current) return;
    const merged = mergeAttachments(attachmentsRef.current, paths);
    applyAttachments(merged.paths);
    if (merged.dropped > 0) props.onError?.(attachmentLimitMessage(merged.dropped));
  };

  const receiveDroppedFiles = (paths: string[]) => {
    if (remoteHost) {
      props.onError?.("当前连接远程电脑，请先将文件传到该电脑，再通过附件按钮填写文件路径。");
    } else addAttachments(paths);
  };
  useDroppedFiles(textareaRef, receiveDroppedFiles, props.onError);

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

  /** Saves clipboard files in the app cache and attaches them to this draft. */
  const attachPastedFiles = async (files: File[]) => {
    if (sendingRef.current || files.length === 0) return;
    if (remoteHost) {
      props.onError?.("当前连接远程电脑，剪贴板文件需先传到该电脑，再附加远程文件路径。");
      return;
    }
    if (!isTauriRuntime()) {
      props.onError?.("粘贴文件仅在 miniQ 桌面应用中可用");
      return;
    }
    try {
      const paths = await attachmentReads.run(() => Promise.all(files.map((file) => savePastedFile(file))));
      addAttachments(paths);
    } catch (error) {
      props.onError?.(
        `无法粘贴文件: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /** Inserts text at the caret, or at the end when the input was idle. */
  const insertDraftText = (text: string) => {
    // Windows clipboards hand text over with CRLF; the draft keeps plain LF.
    const inserted = sanitizeTextInput(text.replace(/\r\n?/g, "\n")).value;
    if (!inserted) return;
    const field = fieldRef.current;
    const value = readComposerValue(field) || draftValueRef.current;
    const area = activeTextarea(field);
    const focused = area !== null && document.activeElement === area;
    const start = focused ? readComposerCaret(field) : value.length;
    const end = focused ? start + area.selectionEnd - area.selectionStart : value.length;
    setDraft(`${value.slice(0, start)}${inserted}${value.slice(end)}`);
    placeCaret(start + inserted.length);
  };

  /** Drops one paste chip and the text it was hiding. */
  const removePaste = (placeholder: string) => {
    const value = draftValueRef.current;
    const at = value.indexOf(placeholder);
    setDraft(at < 0 ? value : `${value.slice(0, at)}${value.slice(at + placeholder.length)}`);
    placeCaret(Math.max(0, at));
  };

  /** Collapses a long paste into a token; the full text returns on send. */
  const insertLargePaste = (text: string) => {
    const placeholder = nextPlaceholder(
      text,
      pastesRef.current.map((paste) => paste.placeholder),
    );
    applyPastes([...pastesRef.current, { placeholder, text }]);
    insertDraftText(placeholder);
  };

  const receivePastedText = (text: string) => {
    // Windows clipboards hand text over with CRLF; the stored text keeps plain LF.
    const normalized = text.replace(/\r\n?/g, "\n");
    if (isLargePaste(normalized)) insertLargePaste(normalized);
    else insertDraftText(normalized);
  };

  // A paste made while the transcript owns the focus has no editor to land in.
  usePastedInput(textareaRef, (paste) => {
    if (paste.files.length > 0) void attachPastedFiles(paste.files);
    if (paste.text) receivePastedText(paste.text);
  });

  /** Claims clipboard files so the WebView cannot insert a file name instead. */
  const pasteClipboard = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardFiles(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      void attachPastedFiles(files);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    // Short text keeps native editing (undo, autocorrect); long text collapses.
    if (!text || !isLargePaste(text)) return;
    event.preventDefault();
    insertLargePaste(text.replace(/\r\n?/g, "\n"));
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
    // Collapsed pastes only exist while editing; the message carries their text.
    const content = expandPastes(draft, pastesRef.current).trim();
    try {
      const accepted = goalMode
        ? await props.onSend(content, attachments, true)
        : await props.onSend(content, attachments);
      if (accepted === false) return;
      storeDraft(key, "");
      storeAttachments(key, []);
      storePastes(key, []);
      if (draftKeyRef.current === key) {
        draftValueRef.current = "";
        setDraftState("");
        attachmentsRef.current = [];
        setAttachments([]);
        pastesRef.current = [];
        setPastes([]);
        setGoalMode(false);
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
        requestAnimationFrame(() => focusTextarea(activeTextarea(fieldRef.current), replacement.length));
    },
  });

  const mention = useComposerMention({
    draft,
    caret,
    enabled: !sending && !slash.pending,
    client: props.client,
    sessionId: props.sessionId,
    inputRef: textareaRef,
    setDraft,
    placeCaret,
  });

  // `miniq:composer-insert` (e.g. timeline quotes): insert at the caret when
  // the input is focused, otherwise append, then leave the caret after it.
  useComposerInsert(textareaRef, (text) => {
    const area = activeTextarea(fieldRef.current);
    if (!area || area.readOnly || area.disabled) return;
    const current = draftValueRef.current;
    const focused = document.activeElement === area;
    const start = focused ? readComposerCaret(fieldRef.current) : current.length;
    const end = focused ? start + area.selectionEnd - area.selectionStart : current.length;
    const result = insertComposerText(current, text, focused ? { start, end } : null);
    setDraft(result.value);
    placeCaret(result.cursor);
  });

  const recallLast = () => {
    const messages = props.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "user") continue;
      if (props.sessionId && message.sessionId && message.sessionId !== props.sessionId) continue;
      if (message.content.trim()) return message.content;
    }
    return undefined;
  };

  const rememberVoiceInsertion = () => {
    voiceDraftRef.current = draft;
    const area = activeTextarea(fieldRef.current);
    const start = area && document.activeElement === area ? readComposerCaret(fieldRef.current) : draft.length;
    voiceRangeRef.current = {
      start,
      end: area && document.activeElement === area ? start + area.selectionEnd - area.selectionStart : draft.length,
    };
  };

  const applyTranscription = (text: string) => {
    let cursor = 0;
    setDraftState((current) => {
      // If the user edited the draft while dictating, insert at their current
      // cursor instead of replacing a selection from an older draft.
      const area = activeTextarea(fieldRef.current);
      const position = area ? readComposerCaret(fieldRef.current) : current.length;
      const range =
        current === voiceDraftRef.current
          ? voiceRangeRef.current
          : { start: position, end: position };
      const result = insertTranscript(current, text, range);
      cursor = result.cursor;
      storeDraft(props.draftKey, result.value);
      return result.value;
    });
    requestAnimationFrame(() => placeComposerCaret(fieldRef.current, cursor));
  };

  useEffect(() => {
    if (props.voiceFocusRequest === undefined || voiceCapabilities.loading || focusedVoiceRequest.current === props.voiceFocusRequest) return;
    const frame = requestAnimationFrame(() => {
      const requestId = props.voiceFocusRequest!;
      focusedVoiceRequest.current = requestId;
      const trigger = card.current?.querySelector<HTMLButtonElement>(".voice-btn:not(:disabled)");
      if (trigger) trigger.focus();
      else {
        focusTextarea(activeTextarea(fieldRef.current));
        props.onError?.("已打开本机会话输入框，当前语音输入不可用；请在设置中确认语音服务后点击语音输入。");
      }
      props.onVoiceFocusApplied?.(requestId);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.voiceFocusRequest, voiceCapabilities.loading, voiceCapabilities.capabilities.transcribe, props.onError, props.onVoiceFocusApplied]);

  const voiceControl = props.client && voiceCapabilities.capabilities.transcribe ? (
    <VoiceInput
      key={props.draftKey}
      client={props.client}
      transcriber={voiceCapabilities.transcriber}
      preferLocal={voiceCapabilities.preferLocal}
      transcribeModel={voiceCapabilities.capabilities.transcribeModel ?? undefined}
      disabled={sending || slash.pending}
      onStart={rememberVoiceInsertion}
      onTranscribed={applyTranscription}
      onPreview={setVoicePreview}
      onError={props.onError}
    />
  ) : null;

  const contextControls = (
    <>
      {props.chipSlot}
      {props.approvalMode && props.onApprovalModeChange && (
        <ApprovalModeSelect
          mode={props.approvalMode}
          onChange={props.onApprovalModeChange}
        />
      )}
    </>
  );

  return (
    <div ref={card} className="composer-card">
      {props.queueSlot}
      {props.chipSlot && <div className="composer-context">{contextControls}</div>}
      {showRemoteAttachment && remoteHost && (props.client?.mode === "remote" && remoteUploadScope ?
        <ComposerRemoteUpload client={props.client} scope={remoteUploadScope} count={attachments.length}
          run={attachmentReads.run} onClose={() => setShowRemoteAttachment(false)}
          onAttach={(paths) => {
            const active = uploadScope.current;
            if (!mountedRef.current || active.client !== props.client || active.scopeKey !== remoteUploadKey || active.draftKey !== props.draftKey) {
              storeAttachments(props.draftKey, mergeAttachments(readAttachments(props.draftKey), paths).paths);
              return;
            }
            addAttachments(paths);
          }} /> : <RemotePathDialog host={remoteHost} purpose="attachment" uploadNeedsProject={props.client?.mode === "remote"}
          onSubmit={async (path) => {
            if (attachments.length >= MAX_COMPOSER_ATTACHMENTS) {
              throw new Error(`每条消息最多附加 ${MAX_COMPOSER_ATTACHMENTS} 个文件`);
            }
            addAttachments([path]);
          }} onClose={() => setShowRemoteAttachment(false)} />)}
      {voicePreview && <VoiceTranscript preview={voicePreview} />}
      {slash.menu}
      {!slash.menu && mention.menu}
      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((path) => (
            <AttachmentPreview
              key={path}
              path={path}
              remote={!!remoteHost}
              sending={sending}
              onRemove={() => applyAttachments(attachmentsRef.current.filter((item) => item !== path))}
            />
          ))}
        </div>
      )}
      <div className="composer-input-row">
        {goalMode && <span className="composer-goal-prefix">目标</span>}
        <ComposerFieldView
          fieldRef={fieldRef}
          draft={draft}
          pastes={pastes}
          readOnly={sending || slash.pending}
          autoFocus={props.autoFocus}
          placeholder={props.busy ? "任务执行中，发送的消息会加入队列..." : props.placeholder}
          describedBy={keyboardHintId}
          enterKeyHint={inputMode.enterSends ? "send" : "enter"}
          inputAttributes={{ ...slash.inputAttributes, ...mention.inputAttributes }}
          onSelect={(event) => setCaret(readComposerCaret(fieldRef.current) - event.currentTarget.value.length + event.currentTarget.selectionStart)}
          onBlur={() => setCaret(-1)}
          onBeforeInput={(event) => {
            const data = (event.nativeEvent as InputEvent).data;
            if (data && containsUnsupportedInput(data)) event.preventDefault();
          }}
          onPaste={pasteClipboard}
          onChange={(event) => {
            const textarea = event.currentTarget;
            const sanitized = sanitizeTextInput(
              textarea.value,
              textarea.selectionStart,
              textarea.selectionEnd,
            );
            const field = fieldRef.current;
            const local = sanitized.changed ? sanitized.value : textarea.value;
            const combined = replaceSegment(field, textarea, local);
            setDraft(combined);
            const caretBase = readComposerCaret(field) - textarea.value.length;
            setCaret(caretBase + (sanitized.changed ? sanitized.end : textarea.selectionStart));
            if (sanitized.changed) {
              requestAnimationFrame(() => {
                textarea.setSelectionRange(sanitized.start, sanitized.end);
              });
            }
          }}
          onKeyDown={(event) => {
            if (slash.onKeyDown(event)) return;
            if (mention.onKeyDown(event)) return;
            if (
              (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey &&
              event.key.toLowerCase() === "u" && !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (canAttach && !sending) void pickFiles();
              return;
            }
            handleComposerFieldKey(event, fieldRef, setDraft, () => void send(), {
              enterSends: inputMode.enterSends,
              recallLast: props.messages ? recallLast : undefined,
            });
          }}
          onRemovePaste={removePaste}
        />
      </div>
      <div className="composer-row">
        <div className="composer-plus" ref={plusRef}>
          <button
            ref={plusButtonRef}
            type="button"
            className={`composer-plus-trigger${plusVisible ? " open" : ""}`}
            aria-label="更多输入方式"
            title="附件、目标与命令"
            aria-haspopup="true"
            aria-expanded={plusVisible}
            aria-controls={plusPanelId}
            onClick={() => setPlusOpen((open) => !open)}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
          <div
            id={plusPanelId}
            className="composer-plus-panel"
            role="group"
            aria-label="更多输入方式"
            hidden={!plusVisible}
          >
            {canAttach && (
              <button
                type="button"
                className="composer-plus-item"
                title={remoteHost ? "附加远程文件" : "附加文件(也可直接拖入窗口)"}
                aria-label={remoteHost ? "附加远程文件" : "附加文件"}
                disabled={sending || slash.pending}
                onClick={() => {
                  setPlusOpen(false);
                  void pickFiles();
                }}
              >
                <Paperclip size={15} aria-hidden="true" />
                <span>{remoteHost ? "附加远程文件" : "附加文件"}</span>
              </button>
            )}
            {props.allowGoal && (
              <button
                type="button"
                className={`composer-plus-item composer-goal-btn${goalMode ? " active" : ""}`}
                aria-pressed={goalMode}
                onClick={() => {
                  setGoalMode((active) => !active);
                  setPlusOpen(false);
                  requestAnimationFrame(() => focusTextarea(activeTextarea(fieldRef.current)));
                }}
                title={goalMode ? "取消设为目标" : "将下一条消息设为目标"}
              >
                <Target size={15} aria-hidden="true" />
                <span>目标</span>
              </button>
            )}
            <button
              type="button"
              className="composer-plus-item"
              title="命令与技能"
              disabled={sending || slash.pending}
              onClick={() => {
                setPlusOpen(false);
                const next = draft.startsWith("/") ? draft : `/${draft}`;
                setDraft(next);
                requestAnimationFrame(() => focusTextarea(activeTextarea(fieldRef.current), 1));
              }}
            >
              <Slash size={15} aria-hidden="true" />
              <span>命令与技能</span>
            </button>

          </div>
        </div>
        {props.chip && (
          <span className="chip" title={props.chip}>
            <Folder aria-hidden="true" />
            <span>{props.chip}</span>
          </span>
        )}
        {!props.chipSlot && contextControls}
        {props.permissionSlot}
        {props.modelSlot}
        <div className="composer-submit">
          <div className="composer-submit-buttons">
            <p id={keyboardHintId} className="composer-keyboard-hint">
              {inputMode.keyboardHint}
            </p>
            {voiceControl && (
              <div className="composer-voice-inline">{voiceControl}</div>
            )}
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
        </div>
      </div>
      {attachmentReads.pending && <p className="composer-send-status" role="status">正在准备附件，完成后可发送</p>}
      {props.sendBlocked && <p className="composer-send-status" role="status">
        {props.sendBlockedReason ?? "暂时无法发送，草稿会保留"}
      </p>}
    </div>
  );
}

/** Bottom-docked composer for an open session. */
export function Composer(props: Omit<ComponentProps<typeof ComposerCard>, "placeholder" | "autoFocus" | "chipSlot"> & { onCancel: () => void }) {
  return (
    <div className="composer-outer">
      <ComposerCard
        {...props}
        placeholder={props.sessionId ? COMPOSER_PLACEHOLDER : "随心输入，/ 使用命令与技能"}
      />
    </div>
  );
}
