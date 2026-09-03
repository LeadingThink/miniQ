import { ArrowLeft, Bot, ImagePlus, Laptop, Send, Square, Wifi, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { isNativeMobileApp } from "../mobileRuntime";
import { DEFAULT_RELAY_URL, loadRemoteCredentials, readRemoteCredentials, storeRemoteCredentials } from "../remoteAccess";
import { Md } from "./Md";

const API_BASE_URL = "https://oneapi.zaiwenai.com/v1";
const CHAT_STORAGE_KEY = "miniq.mobile.chat.v1";

interface ChatMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string; detail?: "auto" } }>;
}

interface PendingImage {
  name: string;
  dataUrl: string;
}

export function MobileEntry(props: { onRemote: () => void }) {
  const saved = readRemoteCredentials();
  const [section, setSection] = useState<"home" | "chat" | "remote">("home");
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? "");
  const [deviceName, setDeviceName] = useState(saved?.deviceName ?? defaultDeviceName());
  const [error, setError] = useState<string | null>(null);
  const [loadingCredentials, setLoadingCredentials] = useState(isNativeMobileApp());

  useEffect(() => {
    if (!isNativeMobileApp()) return;
    void loadRemoteCredentials()
      .then((credentials) => {
        if (!credentials) return;
        setApiKey(credentials.apiKey);
        setDeviceName(credentials.deviceName);
      })
      .finally(() => setLoadingCredentials(false));
  }, []);

  useEffect(() => {
    if (!isNativeMobileApp()) return;
    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;
    void import("@capacitor/app").then(async ({ App }) => {
      if (disposed) return;
      listener = await App.addListener("backButton", () => {
        if (section !== "home") {
          setError(null);
          setSection("home");
        } else {
          void App.minimizeApp();
        }
      });
    });
    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, [section]);

  const persist = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError("请输入在问 API Key");
      return false;
    }
    try {
      await storeRemoteCredentials({ apiKey: key, relayUrl: DEFAULT_RELAY_URL, deviceName: deviceName.trim() || defaultDeviceName() });
      setError(null);
      return true;
    } catch (cause) {
      setError(`无法安全保存 Key：${errorMessage(cause)}`);
      return false;
    }
  };

  if (section === "chat") {
    return <MobileChat apiKey={apiKey.trim()} onBack={() => setSection("home")} />;
  }

  return (
    <main className="mobile-entry">
      <div className="mobile-entry-brand"><span>miniQ</span><small>移动工作台</small></div>
      <section className="mobile-entry-sheet">
        <div className="mobile-entry-heading">
          <h1>{section === "remote" ? "连接桌面 miniQ" : "随时继续工作"}</h1>
          <p>{section === "remote" ? "桌面端开启远程访问后，使用同一个 Key 安全连接。" : "移动问答独立运行；远程桌面可以继续项目任务、查看进度并处理审批。"}</p>
        </div>

        <label className="mobile-entry-field">
          <span>在问 API Key</span>
          <input type="password" autoComplete="off" value={apiKey} placeholder="sk-..." disabled={loadingCredentials} onChange={(event) => setApiKey(event.target.value)} />
          <small>{isNativeMobileApp() ? "Key 保存在系统安全存储中；relay 不接收 Key 原文。" : "Key 只保存在当前浏览器会话中；relay 不接收 Key 原文。"}</small>
        </label>

        {section === "remote" && (
          <label className="mobile-entry-field">
            <span>这台设备的名称</span>
            <input value={deviceName} maxLength={80} onChange={(event) => setDeviceName(event.target.value)} />
          </label>
        )}
        {error && <div className="mobile-entry-error" role="alert">{error}</div>}

        {section === "home" ? (
          <div className="mobile-entry-actions">
            <button type="button" className="mobile-mode-card primary" disabled={loadingCredentials} onClick={() => { void persist().then((ready) => { if (ready) setSection("chat"); }); }}>
              <span className="mobile-mode-icon"><Bot size={21} /></span>
              <span><strong>移动问答</strong><small>桌面不在线也能使用，支持流式回答和历史保留</small></span>
            </button>
            <button type="button" className="mobile-mode-card" disabled={loadingCredentials} onClick={() => { setError(null); setSection("remote"); }}>
              <span className="mobile-mode-icon"><Laptop size={21} /></span>
              <span><strong>远程桌面</strong><small>同步桌面项目、任务进度、会话与待审批操作</small></span>
            </button>
          </div>
        ) : (
          <div className="mobile-entry-footer">
            <button type="button" className="secondary" onClick={() => { setError(null); setSection("home"); }}><ArrowLeft size={15} />返回</button>
            <button type="button" onClick={() => { void persist().then((ready) => { if (ready) props.onRemote(); }); }}><Wifi size={15} />连接桌面端</button>
          </div>
        )}
      </section>
      <p className="mobile-entry-security">会话内容使用 AES-256-GCM 端到端加密，服务器只负责转发。</p>
    </main>
  );
}

function MobileChat(props: { apiKey: string; onBack: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>(readChat);
  const [models, setModels] = useState<string[]>(["gpt-5.6-luna", "gemini-3.7-flash", "grok-4.6"]);
  const [model, setModel] = useState("gpt-5.6-luna");
  const [draft, setDraft] = useState("");
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch(`${API_BASE_URL}/models`, { headers: { Authorization: `Bearer ${props.apiKey}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`读取模型失败（${response.status}）`);
        return response.json() as Promise<{ data?: Array<{ id?: string }> }>;
      })
      .then((result) => {
        const available = (result.data ?? []).map((item) => item.id ?? "").filter(isQuestionModel).sort();
        if (available.length) setModels(available);
      })
      .catch((cause) => setError(errorMessage(cause)));
  }, [props.apiKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // A photo can exceed the browser storage quota; the live conversation
      // must remain usable even when its durable history cannot be written.
    }
    bottomRef.current?.scrollIntoView({ behavior: busy ? "auto" : "smooth" });
  }, [busy, messages]);

  const send = async () => {
    const content = draft.trim();
    if ((!content && !pendingImage) || busy) return;
    const userContent = pendingImage
      ? [
          ...(content ? [{ type: "text" as const, text: content }] : []),
          { type: "image_url" as const, image_url: { url: pendingImage.dataUrl, detail: "auto" as const } },
        ]
      : content;
    const history = [...messages, { role: "user" as const, content: userContent }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setDraft("");
    setPendingImage(null);
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`${API_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${props.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: history, stream: true, max_tokens: 4096 }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(await responseError(response));
      await readSse(response.body, (delta) => {
        setMessages((current) => current.map((message, index) => index === current.length - 1 ? { ...message, content: message.content + delta } : message));
      });
      setMessages((current) => {
        const last = current.at(-1);
        if (last?.role === "assistant" && typeof last.content === "string" && !last.content.trim()) {
          return current.map((message, index) => index === current.length - 1 ? { ...message, content: "模型返回了空内容，请重试或切换模型。" } : message);
        }
        return current;
      });
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const modelOptions = useMemo(() => models.filter((item) => item !== "gemini-3.5-flash" && item !== "grok-4" && item !== "grok-4.1-fast-non-reasoning" && item !== "gpt-5.1-codex-mini" && item !== "claude-fable-5"), [models]);
  return (
    <main className="mobile-chat">
      <header className="mobile-chat-header">
        <button type="button" className="icon-button" aria-label="返回" title="返回" onClick={props.onBack}><ArrowLeft size={18} /></button>
        <div><strong>移动问答</strong><small>独立运行</small></div>
        <select aria-label="问答模型" value={model} onChange={(event) => setModel(event.target.value)}>
          {modelOptions.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </header>
      <section className="mobile-chat-feed">
        {messages.length === 0 && <div className="mobile-chat-empty"><Bot size={28} /><strong>有什么需要一起完成？</strong><span>这里适合随手问答；涉及本地项目时切换到远程桌面。</span></div>}
        {messages.map((message, index) => (
          <article key={index} className={`mobile-chat-message ${message.role}`}>
            {message.role === "assistant" ? (
              <Md>{typeof message.content === "string" ? message.content || (busy && index === messages.length - 1 ? "正在思考..." : "") : ""}</Md>
            ) : (
              <UserMessageContent content={message.content} />
            )}
          </article>
        ))}
        {error && <div className="mobile-entry-error" role="alert">{error}</div>}
        <div ref={bottomRef} />
      </section>
      <form className="mobile-chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        {pendingImage && <div className="mobile-chat-image-chip"><ImagePlus size={14} /><span title={pendingImage.name}>{pendingImage.name}</span><button type="button" aria-label="移除图片" title="移除图片" onClick={() => setPendingImage(null)}><X size={13} /></button></div>}
        <textarea value={draft} rows={2} placeholder="输入问题或任务" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
        }} />
        <label className="mobile-chat-image-button" title="附加图片"><ImagePlus size={16} /><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void readMobileImage(file).then(setPendingImage).catch((cause) => setError(errorMessage(cause))); }} /></label>
        {busy ? (
          <button type="button" className="mobile-chat-send" aria-label="停止" title="停止" onClick={() => abortRef.current?.abort()}><Square size={16} /></button>
        ) : (
          <button type="submit" className="mobile-chat-send" aria-label="发送" title="发送" disabled={!draft.trim() && !pendingImage}><Send size={17} /></button>
        )}
      </form>
    </main>
  );
}

export async function readSse(stream: ReadableStream<Uint8Array>, onDelta: (delta: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>; error?: { message?: string } };
    if (parsed.error?.message) throw new Error(parsed.error.message);
    const delta = parsed.choices?.[0]?.delta?.content;
    if (delta) onDelta(delta);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line.replace(/\r$/, ""));
    if (done) {
      if (buffer) consumeLine(buffer.replace(/\r$/, ""));
      break;
    }
  }
}

async function responseError(response: Response): Promise<string> {
  try {
    const value = await response.json() as { error?: { message?: string } };
    return value.error?.message ?? `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

function readChat(): ChatMessage[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(CHAT_STORAGE_KEY) ?? "[]") as ChatMessage[];
    return Array.isArray(value) ? value.filter((item) => item?.role && (typeof item.content === "string" || Array.isArray(item.content))) : [];
  } catch {
    return [];
  }
}

function UserMessageContent(props: { content: ChatMessage["content"] }) {
  if (typeof props.content === "string") return <>{props.content}</>;
  return <>{props.content.map((part, index) => part.type === "text" ? <span key={index}>{part.text}</span> : part.image_url ? <img key={index} src={part.image_url.url} alt="已附加图片" /> : null)}</>;
}

async function readMobileImage(file: File): Promise<PendingImage> {
  if (file.size > 20 * 1024 * 1024) throw new Error("图片不能超过 20 MB");
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) throw new Error("仅支持 PNG、JPEG、WebP 或 GIF 图片");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败"));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
  return { name: file.name, dataUrl };
}

function isQuestionModel(model: string): boolean {
  return Boolean(model) && !/(^bge-|image|^flux-|imagine|transcribe|tts|^sencevoice-|^suno-|^midjourney$)/i.test(model);
}

function defaultDeviceName(): string {
  const platform = navigator.userAgent.includes("iPhone") ? "iPhone" : navigator.userAgent.includes("Android") ? "Android 手机" : "移动浏览器";
  return `miniQ ${platform}`;
}
