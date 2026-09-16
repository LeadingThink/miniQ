import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Flag, Link, RefreshCw } from "lucide-react";
import { loadShare, reportShare, type SharePage, type SharedFile, type ShareReportReason } from "../sharing";
import { formatFileSize } from "../localFiles";
import { errorMessage } from "../errorMessage";
import { SharedMarkdown } from "./SharedMarkdown";
import { SharedFilePreview } from "./SharedFilePreview";
import "./Sharing.css";

export function SharedSessionPage({ id }: { id: string }) {
  const reading = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<SharePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [file, setFile] = useState<SharedFile | null>(null);
  const [reportReason, setReportReason] = useState<ShareReportReason>("privacy");
  const [reportDetail, setReportDetail] = useState("");
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const changePage = (next: number) => {
    setData(null); setPage(next);
    reading.current?.scrollTo({ top: 0 });
  };
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(null); setFile(null);
    void loadShare(id, page, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setData(value); document.title = `${value.title} · miniQ 分享`;
    }).catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [id, page, attempt]);
  useEffect(() => {
    const tag = document.createElement("meta"); tag.name = "robots"; tag.content = "noindex,nofollow,noarchive"; document.head.append(tag);
    const referrer = document.createElement("meta"); referrer.name = "referrer"; referrer.content = "no-referrer"; document.head.append(referrer);
    return () => { tag.remove(); referrer.remove(); };
  }, []);
  const submitReport = async () => {
    if (reporting || (reportReason === "other" && !reportDetail.trim())) return;
    setReporting(true); setReportError(null);
    try {
      await reportShare(id, reportReason, reportDetail.trim());
      setReported(true); setData(null); setFile(null);
    } catch (cause) {
      setReportError(errorMessage(cause));
    } finally {
      setReporting(false);
    }
  };
  return <div className={`shared-session${file ? " has-preview" : ""}`}>
    <div className="shared-reading" ref={reading}><header className="shared-brand"><a href="./">miniQ</a><span><Link size={14} /> 会话分享 · 只读</span></header>
      <main>
        {reported && <div className="shared-empty" role="status"><h1>举报已提交</h1><p>此分享已立即下架，其他访客无法继续访问。感谢你的反馈。</p></div>}
        {error && !reported && <div className="shared-empty" role="alert"><h1>无法打开分享</h1><p>{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={16} />重试</button></div>}
        {!reported && !data && !error && <p className="shared-empty" role="status">正在加载分享内容…</p>}
        {data && <><h1>{data.title}</h1><p className="shared-subtitle">分享于 {new Date(data.createdAt).toLocaleString()} · {data.messageCount} 条消息 · {new Date(data.expiresAt).toLocaleDateString()} 到期</p>
          {data.files.length > 0 && <section className="shared-artifacts" aria-label="分享文件">{data.files.map((item) => <button key={item.id} type="button" onClick={() => setFile(item)}>
            <FileText size={20} /><span><strong>{item.name}</strong><small>{formatFileSize(item.size)} · 预览 / 下载</small></span></button>)}</section>}
          {data.messages.map((message, index) => <article className={`shared-message ${message.role}`} key={`${page}:${index}`}><header>{message.role === "user" ? "提问者" : "miniQ"}</header>
            <SharedMarkdown files={data.files} onFile={setFile}>{message.content}</SharedMarkdown></article>)}
          <nav className="shared-pagination" aria-label="分享消息分页"><button type="button" disabled={page === 0} onClick={() => changePage(page - 1)}><ChevronLeft size={16} />上一页</button>
            <span>第 {page + 1} 页</span><button type="button" disabled={data.nextPage === null} onClick={() => changePage(data.nextPage!)}>下一页<ChevronRight size={16} /></button></nav>
          <p className="shared-subtitle">这是分享者选择的内容快照，不会公开后续对话。AI 输出请结合实际情况核实。</p>
          <details className="shared-report">
            <summary><Flag size={14} />举报或投诉此分享</summary>
            <form onSubmit={(event) => { event.preventDefault(); void submitReport(); }}>
              <label>原因<select value={reportReason} onChange={(event) => setReportReason(event.target.value as ShareReportReason)}>
                <option value="privacy">泄露隐私或凭证</option>
                <option value="sexual_content">色情或未成年人不当内容</option>
                <option value="violence">暴力或危险内容</option>
                <option value="hate_or_harassment">仇恨、骚扰或欺凌</option>
                <option value="illegal_activity">违法、诈骗或恶意行为</option>
                <option value="copyright">版权或其他权利问题</option>
                <option value="other">其他</option>
              </select></label>
              <label>补充说明（可选）<textarea maxLength={1000} rows={3} value={reportDetail} onChange={(event) => setReportDetail(event.target.value)} /></label>
              <div><a href="https://chat.zaiwenai.com/miniq/support" target="_blank" rel="noreferrer">联系技术支持</a>
                <button type="submit" disabled={reporting || (reportReason === "other" && !reportDetail.trim())}>{reporting ? "正在提交…" : "提交并立即下架"}</button></div>
              {reportError && <p role="alert">{reportError}</p>}
            </form>
          </details>
        </>}
      </main><footer className="shared-footer">由 miniQ 生成 · 自然对话，完成任务</footer>
    </div>
    {file && <SharedFilePreview shareId={id} file={file} onClose={() => setFile(null)} />}
  </div>;
}
