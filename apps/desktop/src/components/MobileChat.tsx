import { ArrowDown, ArrowLeft, ArrowUp, Film, ImagePlus, RefreshCw, Settings, Square, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { handleComposerKeyDown } from "../composerInput";
import { readDraft, storeDraft } from "../composerDraft";
import { useTouchComposerInput } from "../hooks/useTouchComposerInput";
import { errorMessage } from "../errorMessage";
import { mobileMediaContent, readMobileMedia, type PendingMobileMedia } from "../mobileChatMedia";
import { useConversationScroll } from "../hooks/useConversationScroll";
import { useMobileChat } from "../hooks/useMobileChat";
import { useMobileChatModels } from "../hooks/useMobileChatModels";
import { appleSpeechAvailable } from "../appleSpeech";
import { createMobileVoiceTranscriber } from "../mobileVoice";
import { VoiceInput } from "./VoiceInput";
import { VoiceTranscript } from "./VoiceTranscript";
import { insertTranscript } from "../voiceAudio";
import type { VoicePreview } from "../voiceTranscription";
import { MobileChatRow } from "./MobileChatRow";
import { MobileModelPicker } from "./MobileModelPicker";
import { MobileMediaPicker } from "./MobileMediaPicker";
import { BillingDialog } from "./BillingDialog";
import { MobilePlatformTitle } from "./MobilePlatformTitle";
import "./MobileChat.css";

export function MobileChat(props: { apiKey: string; onBack: () => void; onSettings?: () => void; onAccount?: () => void }) {
  const catalog = useMobileChatModels(props.apiKey);
  const [localSpeech, setLocalSpeech] = useState(false);
  useEffect(() => {
    let disposed = false;
    void appleSpeechAvailable().then((available) => { if (!disposed) setLocalSpeech(available); }).catch(() => {});
    return () => { disposed = true; };
  }, []);
  const transcriber = useMemo(() => catalog.transcribeModel
    ? createMobileVoiceTranscriber(props.apiKey, catalog.transcribeModel)
    : undefined, [props.apiKey, catalog.transcribeModel]);
  const canTranscribe = localSpeech || Boolean(catalog.transcribeModel);
  const [voicePreview, setVoicePreview] = useState<VoicePreview | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const voiceDraft = useRef({ text: "", start: 0, end: 0 });
  const chat = useMobileChat(props.apiKey, catalog.models.includes(catalog.model) ? catalog.model : "");
  const [draft, setDraftValue] = useState(() => readDraft("mobile-chat"));
  const setDraft = (value: string) => { setDraftValue(value); storeDraft("mobile-chat", value); };
  const inputMode = useTouchComposerInput();
  const keyboardHintId = useId();
  const [pendingMedia, setPendingMedia] = useState<PendingMobileMedia | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [readingMedia, setReadingMedia] = useState(false);
  const mediaRead = useRef(0);
  // Keep the first rendered message stable when new messages arrive at the tail.
  const [windowStart, setWindowStart] = useState(() => {
    const index = Math.max(0, chat.messages.length - 30);
    return { id: chat.messages[index]?.id, index };
  });
  const firstIndex = chat.messages.findIndex((message) => message.id === windowStart.id);
  const startIndex = firstIndex < 0 ? Math.min(windowStart.index, chat.messages.length) : firstIndex;
  const contentVersion = useMemo(() => [chat.messages, chat.error, catalog.error, mediaError],
    [chat.messages, chat.error, catalog.error, mediaError]);
  const { scrollRef: feedRef, historyTopRef, onScroll,
    jumpToBottom: jumpToLatest, showJump: showLatest } = useConversationScroll({
    viewKey: "mobile-chat",
    cursorKey: startIndex > 0 ? chat.messages[startIndex]?.id ?? null : null,
    autoLoadOlder: true,
    hasOlder: startIndex > 0,
    loadOlder: () => {
      const index = Math.max(0, startIndex - 30);
      setWindowStart({ id: chat.messages[index]?.id, index });
    },
    contentVersion,
  });
  const ready = Boolean(props.apiKey) && !catalog.loading && catalog.models.includes(catalog.model);

  useEffect(() => () => { mediaRead.current += 1; }, []);

  const send = () => {
    const content = draft.trim();
    if ((!content && !pendingMedia) || !ready || readingMedia || voicePreview) return;
    const userContent = mobileMediaContent(content, pendingMedia);
    if (chat.send(userContent)) {
      setDraft("");
      setPendingMedia(null);
      jumpToLatest();
    }
  };
  const attachMedia = async (file: File) => {
    const attempt = ++mediaRead.current;
    setReadingMedia(true);
    setMediaError(null);
    try {
      const media = await readMobileMedia(file);
      if (attempt === mediaRead.current) setPendingMedia(media);
    } catch (cause) {
      if (attempt === mediaRead.current) setMediaError(errorMessage(cause));
    } finally {
      if (attempt === mediaRead.current) setReadingMedia(false);
    }
  };

  return (
    <main className="mobile-chat">
      <header className="mobile-chat-header">
        <button type="button" className="icon-button" aria-label="返回" title="返回" onClick={props.onBack}><ArrowLeft size={18} /></button>
        <strong><MobilePlatformTitle fallback="移动问答" /></strong>
        {props.onSettings && <button type="button" className="icon-button" aria-label="设置" title="设置" onClick={props.onSettings}><Settings size={18} /></button>}
      </header>
      <section className="mobile-chat-feed" ref={feedRef} tabIndex={0} aria-label="问答记录" onScroll={onScroll}>
        <div ref={historyTopRef} aria-hidden="true" />
        {chat.messages.length === 0 && <div className="mobile-chat-empty">
          <span className="mobile-chat-empty-mark" aria-hidden="true">Q</span>
          <h1>今天想聊点什么？</h1>
          <p>有问题就问，也可以附加照片或视频。</p>
        </div>}
        {chat.messages.slice(startIndex).map((message) => (
          <MobileChatRow key={message.id} message={message} active={chat.busy && message.id === chat.activeMessageId} onDelete={chat.deleteMessage} />
        ))}
        {!props.apiKey && <div role="status">发送前请在设置中保存 Key 并同意隐私政策。{props.onSettings && <button type="button" onClick={props.onSettings}>前往设置</button>}</div>}
        {catalog.error && <div className="mobile-entry-error" role="alert">{catalog.error}<button type="button" className="mobile-chat-retry" onClick={catalog.reload}>重新加载模型</button></div>}
        {(chat.error || mediaError) && <div className="mobile-entry-error" role="alert">{mediaError || chat.error}</div>}
        <BillingDialog error={mediaError || chat.error} onChangeKey={props.onSettings} onPurchase={props.onAccount} />
        {chat.storageWarning && <div className="mobile-entry-error" role="status">设备存储空间不足，本次内容暂时仅保留在当前页面；离开前请复制重要内容。</div>}
        {!chat.busy && chat.canRetry && <button type="button" className="mobile-chat-retry" disabled={!ready} onClick={() => { if (chat.retry()) jumpToLatest(); }}><RefreshCw size={14} />重新回答</button>}
        {showLatest && <button type="button" className="mobile-chat-jump" onClick={jumpToLatest}><ArrowDown size={14} />查看最新内容</button>}
      </section>
      <form className="mobile-chat-composer" aria-label="问答输入" onSubmit={(event) => { event.preventDefault(); send(); }}>
        {pendingMedia && <div className="mobile-chat-media-chip">{pendingMedia.kind === "video" ? <Film size={14} /> : <ImagePlus size={14} />}<span title={pendingMedia.name}>{pendingMedia.name}</span><button type="button" aria-label={pendingMedia.kind === "video" ? "移除视频" : "移除图片"} title="移除附件" onClick={() => setPendingMedia(null)}><X size={13} /></button></div>}
        {pendingMedia?.kind === "video" && <p className="mobile-chat-media-hint">请使用支持视频理解的模型。</p>}
        {voicePreview && <VoiceTranscript preview={voicePreview} />}
        <textarea ref={textarea} value={draft} rows={2} aria-label="输入问题或任务" aria-describedby={keyboardHintId} enterKeyHint={inputMode.enterSends ? "send" : "enter"} placeholder="有什么想问的…" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => handleComposerKeyDown(event, setDraft, send, inputMode)} />
        <div className="mobile-chat-composer-toolbar">
          <MobileModelPicker catalog={catalog} disabled={chat.busy} />
          <MobileMediaPicker disabled={readingMedia} onMedia={attachMedia} onError={setMediaError} />
          {canTranscribe && <VoiceInput key={props.apiKey} transcriber={transcriber} preferLocal={localSpeech} disabled={readingMedia}
            onStart={() => { voiceDraft.current = { text: draft, start: textarea.current?.selectionStart ?? draft.length, end: textarea.current?.selectionEnd ?? draft.length }; }}
            onPreview={setVoicePreview} onError={setMediaError} onTranscribed={(text) => {
              const input = textarea.current;
              setDraftValue((current) => {
                const saved = voiceDraft.current;
                const range = saved.text === current ? saved : { start: input?.selectionStart ?? current.length, end: input?.selectionEnd ?? current.length };
                const result = insertTranscript(current, text, range);
                storeDraft("mobile-chat", result.value);
                requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(result.cursor, result.cursor); });
                return result.value;
              });
            }} />}
          {chat.busy ? <button type="button" className="mobile-chat-send" aria-label="停止" title="停止" onClick={chat.stop}><Square size={16} /></button>
            : <button type="submit" className="mobile-chat-send" aria-label="发送" title="发送" disabled={Boolean(voicePreview) || !ready || readingMedia || (!draft.trim() && !pendingMedia)}><ArrowUp size={20} /></button>}
        </div>
        <div id={keyboardHintId} className="mobile-chat-keyboard-hint">{inputMode.keyboardHint}</div>
      </form>
    </main>
  );
}
