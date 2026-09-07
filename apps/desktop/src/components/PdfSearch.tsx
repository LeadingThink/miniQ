import { ChevronLeft, ChevronRight, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { searchPdf, type PdfMatch, type PdfTextDocument } from "../pdfSearch";

export function PdfSearch({ document, onPage }: { document: PdfTextDocument | null; onPage: (page: number) => void }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PdfMatch[]>([]);
  const [index, setIndex] = useState(-1);
  const [scanned, setScanned] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setMatches([]);
    setIndex(-1);
    setScanned(0);
    setError(null);
    setSearching(Boolean(document && query.trim()));
    const timer = window.setTimeout(() => {
      if (!document || !query.trim()) return;
      void searchPdf(document, query, controller.signal, setScanned)
        .then((result) => {
          if (!controller.signal.aborted) setMatches(result);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(String(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [document, query]);
  const move = (direction: number) => {
    const next =
      index < 0 ? (direction > 0 ? 0 : matches.length - 1) : (index + direction + matches.length) % matches.length;
    if (!matches[next]) return;
    setIndex(next);
    onPage(matches[next].page);
  };
  return (
    <div className="pdf-search" aria-label="PDF 全文搜索">
      <label className="timeline-search">
        <Search size={14} />
        <input
          type="search"
          aria-label="搜索 PDF 全文"
          disabled={!document}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
        />
      </label>
      {query && (
        <button
          type="button"
          className="icon-button"
          title="清空 PDF 搜索"
          aria-label="清空 PDF 搜索"
          onClick={() => setQuery("")}
        >
          <X size={14} />
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        title="上一个匹配页"
        aria-label="上一个匹配页"
        disabled={!matches.length}
        onClick={() => move(-1)}
      >
        <ChevronLeft size={14} />
      </button>
      <button
        type="button"
        className="icon-button"
        title="下一个匹配页"
        aria-label="下一个匹配页"
        disabled={!matches.length}
        onClick={() => move(1)}
      >
        <ChevronRight size={14} />
      </button>
      {query.trim() && (
        <span role="status">
          {searching ? (
            <>
              <LoaderCircle size={12} className="activity-spinner" />
              {scanned}/{document?.numPages} 页
            </>
          ) : error ? (
            "搜索失败"
          ) : matches.length ? (
            `${index < 0 ? "-" : index + 1}/${matches.length} 页 · ${matches.reduce((count, match) => count + match.count, 0)} 处`
          ) : (
            "无匹配文本"
          )}
        </span>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
