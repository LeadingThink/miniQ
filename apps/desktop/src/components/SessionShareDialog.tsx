import { useCallback, useEffect, useRef, useState } from "react";
import { Share2, X } from "lucide-react";
import type { RpcClient } from "../rpc";
import type { Artifact, HistoryPage, Message } from "../types";
import type { ShareLink } from "../sharing";
import { errorMessage } from "../errorMessage";
import { SharedMarkdown } from "./SharedMarkdown";
import { CopyButton } from "./CopyButton";
import { openExternalUrl } from "../externalLinks";
import "./Sharing.css";

type Props = { client: RpcClient; sessionId: string; title: string; artifacts: Artifact[]; onClose: () => void };

export function SessionShareDialog(props: Props) { return <ShareDialog key={props.sessionId} {...props} />; }

function ShareDialog({ client, sessionId, title: initialTitle, artifacts, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(initialTitle);
  const [days, setDays] = useState(30);
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<HistoryPage["nextCursor"]>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [files, setFiles] = useState(new Set<string>());
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [linksAfter, setLinksAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShareLink | null>(null);
  const request = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const publishId = useRef<string | null>(null);
  const mounted = useRef(true);
  const refreshLinks = useCallback(async (after: string | null = null) => {
    const value = await client.call<{ shares: ShareLink[]; nextCursor: string | null }>("session.shareList", { sessionId, after });
    if (!mounted.current) return;
    setLinks((previous) => after ? [...previous, ...value.shares] : value.shares);
    setLinksAfter(value.nextCursor);
  }, [client, sessionId]);

  const loadHistory = async (before: HistoryPage["nextCursor"] = null) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true);
    try {
      const page = await client.call<HistoryPage>("session.history", { sessionId, before, limit: 50, filter: "answers" }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setMessages((previous) => before ? [...page.messages, ...previous] : page.messages);
      setSelected((previous) => new Set([...(before ? previous : []), ...page.messages.map((message) => message.id)]));
      setCursor(page.nextCursor); setError(null); publishId.current = null;
    } catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };

  useEffect(() => {
    mounted.current = true;
    dialog.current!.showModal();
    void loadHistory();
    void refreshLinks().catch((cause) => { if (mounted.current) setError(errorMessage(cause)); });
    return () => { mounted.current = false; request.current?.abort(); dialog.current?.close(); };
  }, []);

  const publish = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setPublishing(true); setError(null);
    publishId.current ??= crypto.randomUUID().replaceAll("-", "");
    try {
      const link = await client.call<ShareLink>("session.shareCreate", {
        sessionId, id: publishId.current, title, messageIds: [...selected], artifactIds: [...files], expiresInDays: days,
      }, { timeoutMs: 15 * 60 * 1000 });
      if (!mounted.current) return;
      setResult(link); publishId.current = null;
      await refreshLinks();
    } catch (cause) {
      if (mounted.current) {
        const message = errorMessage(cause);
        if (/分享内容已变化|文件在上传期间发生变化/.test(message)) publishId.current = null;
        setError(message); void refreshLinks().catch(() => {});
      }
    }
    finally { inFlight.current = false; if (mounted.current) setPublishing(false); }
  };

  const revoke = async (link: ShareLink) => {
    if (inFlight.current) return;
    inFlight.current = true; setPublishing(true);
    try {
      await client.call("session.shareRevoke", { sessionId, id: link.id });
      if (!mounted.current) return;
      setLinks((links) => links.filter((value) => value.id !== link.id));
      if (result?.id === link.id) setResult(null);
      setError(null);
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { inFlight.current = false; if (mounted.current) setPublishing(false); }
  };

  const toggle = (id: string, values: Set<string>, setter: (values: Set<string>) => void) => {
    const next = new Set(values); if (next.has(id)) next.delete(id); else next.add(id);
    setter(next); publishId.current = null;
  };
  return <dialog ref={dialog} className="share-dialog" aria-labelledby="share-title" onCancel={(event) => { event.preventDefault(); if (!publishing) onClose(); }}>
    <header><div><Share2 size={20} /><h2 id="share-title">分享会话</h2></div>
      <button type="button" className="icon-button" aria-label="关闭分享" disabled={publishing} onClick={onClose}><X size={18} /></button></header>
    <p>拥有链接的人可查看所选内容，你的电脑离线后也可打开。后续消息不会自动同步。</p>
    <fieldset disabled={publishing}>
      <label>分享标题<input value={title} maxLength={300} onChange={(event) => { setTitle(event.target.value); publishId.current = null; }} /></label>
      <label>有效期<select value={days} onChange={(event) => { setDays(Number(event.target.value)); publishId.current = null; }}>
        <option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select></label>
      <div className="share-selection-heading"><strong>已选 {selected.size} 条消息</strong>
        <button type="button" onClick={() => { setSelected(new Set(messages.map((message) => message.id))); publishId.current = null; }}>全选已加载</button>
        <button type="button" onClick={() => { setSelected(new Set()); publishId.current = null; }}>清空</button></div>
      {cursor && <button type="button" disabled={loading} onClick={() => void loadHistory(cursor)}>加载更早的消息并加入选择</button>}
      {loading && <p role="status">正在读取消息…</p>}
      {!loading && !messages.length && <button type="button" onClick={() => void loadHistory()}>重新读取消息</button>}
      <div className="share-message-selection">{messages.map((message, index) => <div key={message.id} className="share-message-choice">
        <input type="checkbox" aria-label={`分享第 ${index + 1} 条消息`} checked={selected.has(message.id)} onChange={() => toggle(message.id, selected, setSelected)} />
        <details><summary>{message.role === "user" ? "你" : "miniQ"} · {new Date(message.createdAt).toLocaleString()} · 展开预览</summary>
          <SharedMarkdown>{message.content}</SharedMarkdown></details>
      </div>)}</div>
      {artifacts.length > 0 && <div className="share-files-select"><strong>附带生成文件（可选）</strong>
        {artifacts.map((artifact) => <label key={artifact.id}><input type="checkbox" checked={files.has(artifact.id)} onChange={() => toggle(artifact.id, files, setFiles)} />{artifact.title || artifact.path.split(/[\\/]/).pop()}</label>)}
        <small>所选文件将上传完整副本，可由访客预览或下载。单个上限 256 MB，总计 512 MB。</small></div>}
    </fieldset>
    <p className="share-note">仅分享勾选的正文和文件。请在展开预览中确认内容；工具日志、系统提示和其他本地文件不会公开。</p>
    {error && <p role="alert">{error}</p>}
    {result && <div className="share-result" role="status"><strong>链接已生成</strong><input readOnly aria-label="分享链接" value={result.url} onFocus={(event) => event.target.select()} />
      <CopyButton content={result.url} label="复制分享链接" /><button type="button" onClick={() => void openExternalUrl(new URL(result.url)).catch((cause) => setError(errorMessage(cause)))}>打开分享</button></div>}
    <footer><span>{publishing ? "正在处理，请勿关闭。大文件上传可能需要几分钟。" : `${selected.size} 条消息 · ${files.size} 个文件`}</span>
      <button type="button" className="primary" disabled={publishing || loading || !selected.size || !title.trim()} onClick={() => void publish()}>{publishing ? "处理中…" : "生成分享链接"}</button></footer>
    <section className="share-existing"><h3>此会话的分享链接</h3><button type="button" disabled={publishing} onClick={() => void refreshLinks().catch((cause) => setError(errorMessage(cause)))}>刷新链接</button>
      {links.map((link) => <div key={link.id}><span>{link.title} · {link.published ? `${new Date(link.expiresAt).toLocaleDateString()} 到期` : "上传未完成"}</span>
        {link.published && <CopyButton content={link.url} label="复制已有分享链接" />}
        <button type="button" disabled={publishing} onClick={() => void revoke(link)}>{link.published ? "撤销分享" : "删除未完成上传"}</button></div>)}
      {linksAfter && <button type="button" onClick={() => void refreshLinks(linksAfter).catch((cause) => setError(errorMessage(cause)))}>更多链接</button>}
    </section>
  </dialog>;
}
