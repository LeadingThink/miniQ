import { ArrowDown, ArrowLeft, Bot, ImagePlus, RefreshCw, Send, Square, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { handleComposerKeyDown } from "../composerInput";
import { readDraft, storeDraft } from "../composerDraft";
import { useTouchComposerInput } from "../hooks/useTouchComposerInput";
import { errorMessage } from "../errorMessage";
import { readMobileImage, type PendingMobileImage } from "../mobileChatData";
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
import { BillingDialog } from "./BillingDialog";

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
  const [pendingImage, setPendingImage] = useState<PendingMobileImage | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [readingImage, setReadingImage] = useState(false);
  const imageRead = useRef(0);
  // Keep the first rendered message stable when new messages arrive at the tail.
  const [windowStart, setWindowStart] = useState(() => {
    const index = Math.max(0, chat.messages.length - 30);
    return { id: chat.messages[index]?.id, index };
  });
  const firstIndex = chat.messages.findIndex((message) => message.id === windowStart.id);
  const startIndex = firstIndex < 0 ? Math.min(windowStart.index, chat.messages.length) : firstIndex;
  const contentVersion = useMemo(() => [chat.messages, chat.error, catalog.error, imageError],
    [chat.messages, chat.error, catalog.error, imageError]);
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

  useEffect(() => () => { imageRead.current += 1; }, []);

  const send = () => {
    const content = draft.trim();
    if ((!content && !pendingImage) || !ready || readingImage || voicePreview) return;
    const userContent = pendingImage
      ? [...(content ? [{ type: "text" as const, text: content }] : []),
        { type: "image_url" as const, image_url: { url: pendingImage.dataUrl, detail: "auto" as const } }]
      : content;
    if (chat.send(userContent)) {
      setDraft("");
      setPendingImage(null);
      jumpToLatest();
    }
  };
  const attachImage = async (file: File) => {
    const attempt = ++imageRead.current;
    setReadingImage(true);
    setImageError(null);
    try {
      const image = await readMobileImage(file);
      if (attempt === imageRead.current) setPendingImage(image);
    } catch (cause) {
      if (attempt === imageRead.current) setImageError(errorMessage(cause));
    } finally {
      if (attempt === imageRead.current) setReadingImage(false);
    }
  };

  return (
    <main className="mobile-chat">
      <header className="mobile-chat-header">
        <button type="button" className="icon-button" aria-label="返回" title="返回" onClick={props.onBack}><ArrowLeft size={18} /></button>
        <div><strong>移动问答</strong><small>独立运行</small></div>
        <MobileModelPicker catalog={catalog} disabled={chat.busy} />
        {props.onSettings && <button type="button" onClick={props.onSettings}>设置</button>}
      </header>
      <section className="mobile-chat-feed" ref={feedRef} tabIndex={0} aria-label="问答记录" onScroll={onScroll}>
        <div ref={historyTopRef} aria-hidden="true" />
        {chat.messages.length === 0 && <div className="mobile-chat-empty"><Bot size={28} /><strong>有什么需要一起完成？</strong><span>这里适合随手问答；涉及本地项目时切换到远程桌面。</span></div>}
        {chat.messages.slice(startIndex).map((message) => (
          <MobileChatRow key={message.id} message={message} active={chat.busy && message.id === chat.activeMessageId} onDelete={chat.deleteMessage} />
        ))}
        {!props.apiKey && <div role="status">发送前请在设置中保存 Key 并同意隐私政策。{props.onSettings && <button type="button" onClick={props.onSettings}>前往设置</button>}</div>}
        {catalog.error && <div className="mobile-entry-error" role="alert">{catalog.error}<button type="button" className="mobile-chat-retry" onClick={catalog.reload}>重新加载模型</button></div>}
        {(chat.error || imageError) && <div className="mobile-entry-error" role="alert">{imageError || chat.error}</div>}
        <BillingDialog error={imageError || chat.error} onChangeKey={props.onSettings} onPurchase={props.onAccount} />
        {chat.storageWarning && <div className="mobile-entry-error" role="status">设备存储空间不足，本次内容暂时仅保留在当前页面；离开前请复制重要内容。</div>}
        {!chat.busy && chat.canRetry && <button type="button" className="mobile-chat-retry" disabled={!ready} onClick={() => { if (chat.retry()) jumpToLatest(); }}><RefreshCw size={14} />重新回答</button>}
        {showLatest && <button type="button" className="mobile-chat-jump" onClick={jumpToLatest}><ArrowDown size={14} />查看最新内容</button>}
      </section>
      <form className={`mobile-chat-composer${canTranscribe ? " with-voice" : ""}`} onSubmit={(event) => { event.preventDefault(); send(); }}>
        {pendingImage && <div className="mobile-chat-image-chip"><ImagePlus size={14} /><span title={pendingImage.name}>{pendingImage.name}</span><button type="button" aria-label="移除图片" title="移除图片" onClick={() => setPendingImage(null)}><X size={13} /></button></div>}
        {voicePreview && <VoiceTranscript preview={voicePreview} />}
        <textarea ref={textarea} value={draft} rows={2} aria-label="输入问题或任务" aria-describedby={keyboardHintId} enterKeyHint={inputMode.enterSends ? "send" : "enter"} placeholder="输入问题或任务" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => handleComposerKeyDown(event, setDraft, send, inputMode)} />
        <label className="mobile-chat-image-button" title={readingImage ? "正在读取图片" : "附加图片"}><ImagePlus size={16} /><input type="file" aria-label="附加图片" disabled={readingImage} accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = "";
          if (file) void attachImage(file);
        }} /></label>
        {canTranscribe && <VoiceInput key={props.apiKey} transcriber={transcriber} preferLocal={localSpeech} disabled={readingImage}
          onStart={() => { voiceDraft.current = { text: draft, start: textarea.current?.selectionStart ?? draft.length, end: textarea.current?.selectionEnd ?? draft.length }; }}
          onPreview={setVoicePreview} onError={setImageError} onTranscribed={(text) => {
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
          : <button type="submit" className="mobile-chat-send" aria-label="发送" title="发送" disabled={Boolean(voicePreview) || !ready || readingImage || (!draft.trim() && !pendingImage)}><Send size={17} /></button>}
        <div id={keyboardHintId} className="mobile-chat-keyboard-hint">{inputMode.keyboardHint}</div>
      </form>
    </main>
  );
}
