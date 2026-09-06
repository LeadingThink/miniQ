import { useMemo, useState } from "react";
import { isolatedHtml } from "../htmlPreview";

export function HtmlPreview({
  content,
  label,
}: {
  content: string;
  label: string;
}) {
  const [network, setNetwork] = useState(false);
  const source = useMemo(
    () => isolatedHtml(content, network),
    [content, network]
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
      <iframe
        title={label}
        srcDoc={source}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    </section>
  );
}
