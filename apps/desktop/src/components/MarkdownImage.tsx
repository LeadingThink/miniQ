import { useEffect, useRef, useState } from "react";
import { readLocalFilePreview, resolveWorkspacePath } from "../localFiles";
import { decodeBase64 } from "../previewBinary";

export function MarkdownImage(props: {
  src?: string;
  alt?: string;
  title?: string;
  workspacePath: string;
  workspacePaths: readonly string[];
  referenceBasePath: string;
}) {
  const { src = "", alt = "", title, workspacePath, referenceBasePath } = props;
  const roots = JSON.stringify(props.workspacePaths);
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const remote = /^https?:\/\//i.test(src);
  useEffect(() => {
    if (!ref.current || remote) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [remote]);
  useEffect(() => {
    if (remote || !visible) return;
    let cancelled = false;
    let url: string | undefined;
    setSource(null);
    setError(null);
    const path = src && resolveWorkspacePath(src, referenceBasePath);
    if (
      !path ||
      (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src))
    ) {
      setError("图片路径无效");
      return;
    }
    void readLocalFilePreview(path, workspacePath, JSON.parse(roots))
      .then((file) => {
        if (cancelled) return;
        if (file.kind !== "image" && file.mimeType !== "image/svg+xml")
          throw new Error("不是支持的图片格式");
        const data = file.dataBase64
          ? decodeBase64(file.dataBase64)
          : file.content;
        if (data === null) throw new Error("图片内容为空");
        url = URL.createObjectURL(new Blob([data], { type: file.mimeType }));
        setSource(url);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, remote, visible, referenceBasePath, workspacePath, roots, attempt]);
  return (
    <span ref={ref} className="markdown-image">
      {error ? (
        <span role="status">
          {alt || "图片"}：{error}{" "}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            重试
          </button>
        </span>
      ) : remote || source ? (
        <img
          src={remote ? src : source!}
          alt={alt}
          title={title}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setError("图片加载失败")}
        />
      ) : (
        <span aria-busy="true">{alt || "正在读取图片..."}</span>
      )}
    </span>
  );
}
