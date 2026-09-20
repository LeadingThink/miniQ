import { FileText, Folder, ArrowUp, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { formatFileSize } from "../localFiles";
import type { FileReadOptions, RemoteDirectory } from "../remoteFiles";

export function RemoteFileBrowser({
  access,
  onOpen,
  label = "远端项目文件",
}: {
  access: FileReadOptions;
  onOpen: (path: string) => void;
  label?: string;
}) {
  const { client, sessionId } = access;
  const [location, setLocation] = useState({ client, sessionId, path: "" });
  const path =
    location.client === client && location.sessionId === sessionId
      ? location.path
      : "";
  const setPath = (value: string) =>
    setLocation({ client, sessionId, path: value });
  const [loaded, setLoaded] = useState<{
    client: FileReadOptions["client"];
    sessionId: FileReadOptions["sessionId"];
    path: string;
    page: RemoteDirectory;
  } | null>(null);
  const page =
    loaded &&
    loaded.client === client &&
    loaded.sessionId === sessionId &&
    loaded.path === path
      ? loaded.page
      : null;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failedCursor, setFailedCursor] = useState<string>();
  const request = useRef<AbortController>();

  const load = useCallback(
    async (after?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError(null);
      setFailedCursor(undefined);
      try {
        if (!client || !sessionId) throw new Error("请先打开会话");
        const next = await client.call<RemoteDirectory>(
          "file.list",
          { sessionId, path, after },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted)
          setLoaded((previous) => ({
            client,
            sessionId,
            path,
            page:
              after &&
              previous &&
              previous.client === client &&
              previous.sessionId === sessionId &&
              previous.path === path
                ? {
                    ...next,
                    entries: [...previous.page.entries, ...next.entries],
                  }
                : next,
          }));
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause));
          setFailedCursor(after);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [client, sessionId, path],
  );
  useEffect(() => {
    setLoaded(null);
    void load();
    return () => request.current?.abort();
  }, [load]);

  return (
    <section
      className="remote-file-browser"
      aria-label={label}
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
              onClick={() => void load()}
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
      {loading && <p role="status">正在读取目录…</p>}
      {error && (
        <div role="alert">
          {error}
          <button type="button" onClick={() => void load(failedCursor)}>
            重试
          </button>
        </div>
      )}
    </section>
  );
}
