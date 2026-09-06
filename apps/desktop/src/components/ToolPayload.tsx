import { ChevronLeft, ChevronRight, WrapText } from "lucide-react";
import { useMemo, useState } from "react";
import { payloadPage, payloadText } from "../timelineModel";
import { CopyButton } from "./CopyButton";

export function ToolPayload({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  const raw = useMemo(() => payloadText(value), [value]);
  const fields = useMemo(
    () =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        : [],
    [value]
  );
  const [field, setField] = useState<string | null>(() =>
    fields.some(([name]) => name === "stdout") ? "stdout" : null
  );
  const text = fields.find(([name]) => name === field)?.[1] ?? raw;
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [wrap, setWrap] = useState(false);
  const result = useMemo(
    () => payloadPage(text, query, page),
    [text, query, page]
  );
  return (
    <section className="tool-payload" aria-label={label}>
      <header>
        <strong>{label}</strong>
        {fields.length > 0 && (
          <select
            aria-label={`${label}显示字段`}
            value={field ?? ""}
            onChange={(event) => {
              setField(event.target.value || null);
              setPage(0);
            }}
          >
            <option value="">完整 JSON</option>
            {fields.map(([name]) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        <input
          type="search"
          aria-label={`搜索${label}`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
        <button
          type="button"
          className="icon-button"
          title="长行折行"
          aria-label={`${label}长行折行`}
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <WrapText size={14} />
        </button>
        <CopyButton label={`复制完整${label}`} content={raw} />
      </header>
      <pre
        style={{
          whiteSpace: wrap ? "pre-wrap" : "pre",
          overflowWrap: wrap ? "anywhere" : "normal",
        }}
      >
        {result.lines.map((line) => (
          <span className="payload-line" key={line.number}>
            <i aria-hidden="true">{line.number}</i>
            {line.text || "\n"}
          </span>
        ))}
      </pre>
      {!result.total && <div role="status">没有匹配的内容</div>}
      {result.pageCount > 1 && (
        <footer>
          <button
            type="button"
            className="icon-button"
            title="上一页"
            aria-label={`${label}上一页`}
            disabled={result.page === 0}
            onClick={() => setPage(result.page - 1)}
          >
            <ChevronLeft size={14} />
          </button>
          <span>
            {result.page + 1} / {result.pageCount} · {result.total} 行
          </span>
          <button
            type="button"
            className="icon-button"
            title="下一页"
            aria-label={`${label}下一页`}
            disabled={result.page + 1 >= result.pageCount}
            onClick={() => setPage(result.page + 1)}
          >
            <ChevronRight size={14} />
          </button>
        </footer>
      )}
    </section>
  );
}
