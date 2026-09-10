import { FileText, Folder, ArrowUp, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { formatFileSize } from "../localFiles";
import type { FileReadOptions, RemoteDirectory } from "../remoteFiles";

export function RemoteFileBrowser({
  access,
  onOpen,
}: {
  access: FileReadOptions;
  onOpen: (path: string) => void;
}) {
  const [path, setPath] = useState("");
  const [page, setPage] = useState<RemoteDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const request = useRef<AbortController>();
  const { client, sessionId } = access;

  async function load(after?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      if (!client || !sessionId) throw new Error("请先打开会话");
      const next = await client.call<RemoteDirectory>(
        "file.list",
        { sessionId, path, after },
        { signal: controller.signal },
      );
      if (!controller.signal.aborted)
        setPage((previous) =>
          after && previous
            ? { ...next, entries: [...previous.entries, ...next.entries] }
            : next,
        );
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    setPage(null);
    void load();
    return () => request.current?.abort();
  }, [path, client, sessionId, attempt]);

  return (
    <section
      className="remote-file-browser"
      aria-label="远端项目文件"
      aria-busy={loading}
    >
      {page && (
        <>
          <select
            aria-label="项目目录"
            value={page.roots.includes(page.path) ? page.path : ""}
            onChange={(event) => setPath(event.target.value)}
          >
            {!page.roots.includes(page.path) && (
              <option value="">{page.path}</option>
            )}
            {page.roots.map((root) => (
              <option key={root} value={root}>
                {root}
              </option>
            ))}
          </select>
          <div className="remote-file-location">
            <button
              type="button"
              className="icon-button"
              aria-label="上一级目录"
              disabled={!page.parent || loading}
              onClick={() => setPath(page.parent!)}
            >
              <ArrowUp size={16} />
            </button>
            <span title={page.path}>{page.path}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="刷新文件列表"
              disabled={loading}
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="remote-file-list">
            {page.entries.map((entry) => (
              <button
                type="button"
                className="ghost"
                key={entry.path}
                disabled={loading || entry.unavailable}
                onClick={() =>
                  entry.directory ? setPath(entry.path) : onOpen(entry.path)
                }
              >
                {entry.directory ? (
                  <Folder size={17} />
                ) : (
                  <FileText size={17} />
                )}
                <span>{entry.name}</span>
                <small>
                  {entry.unavailable
                    ? "不可访问"
                    : entry.directory
                      ? "文件夹"
                      : formatFileSize(entry.size)}
                </small>
              </button>
            ))}
            {!page.entries.length && !loading && <p>此目录暂无文件</p>}
          </div>
          {page.nextCursor && (
            <button
              type="button"
              className="ghost"
              disabled={loading}
              onClick={() => void load(page.nextCursor!)}
            >
              加载更多文件
            </button>
          )}
        </>
      )}
      {loading && <p role="status">正在读取远端目录…</p>}
      {error && (
        <div role="alert">
          {error}
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试
          </button>
        </div>
      )}
    </section>
  );
}
