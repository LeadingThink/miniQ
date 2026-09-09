import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isolatedHtml } from "../htmlPreview";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";
import {
  closeHtmlPreview,
  openHtmlPreview,
  type HtmlPreviewFile,
  type HtmlPreviewHandle,
} from "../localHtmlPreview";

export function HtmlPreview({
  content,
  label,
  file,
}: {
  content: string;
  label: string;
  file?: HtmlPreviewFile;
}) {
  const [network, setNetwork] = useState(false);
  const [openedState, setOpenedState] = useState<{
    scope: string;
    handle: HtmlPreviewHandle;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const local = isTauriRuntime() && !!file;
  const identity = JSON.stringify(file);
  const scope = JSON.stringify([identity, network, attempt]);
  const handle = openedState?.scope === scope ? openedState.handle : null;
  useEffect(() => {
    if (!local || !identity) return;
    let disposed = false;
    let opened: HtmlPreviewHandle | null = null;
    setOpenedState(null);
    setError(null);
    const close = (value: HtmlPreviewHandle) => {
      void closeHtmlPreview(value.id).catch(() =>
        console.warn("Unable to revoke HTML preview origin"),
      );
    };
    void openHtmlPreview(JSON.parse(identity) as HtmlPreviewFile, network)
      .then((value) => {
        opened = value;
        if (disposed) close(value);
        else setOpenedState({ scope, handle: value });
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      });
    return () => {
      disposed = true;
      if (opened) close(opened);
    };
  }, [local, identity, network, scope, content]);
  const source = useMemo(
    () => (local ? undefined : isolatedHtml(content, network)),
    [content, network, local],
  );
  return (
    <section className="html-preview">
      <div className="html-preview-toolbar">
        <span>HTML · 隔离预览</span>
        <label title="允许此文件在预览中请求外部资源">
          <input
            type="checkbox"
            checked={network}
            onChange={(event) => setNetwork(event.target.checked)}
          />
          联网资源
        </label>
      </div>
      {error && (
        <div role="alert" className="review-error">
          <span>{error}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="重试 HTML 预览"
            title="重试 HTML 预览"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      )}
      {local && !handle && !error && <p role="status">正在加载 HTML 预览</p>}
      {(!local || handle) && (
        <iframe
          title={label}
          src={local ? handle?.url : undefined}
          srcDoc={local ? undefined : source}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
      )}
    </section>
  );
}
