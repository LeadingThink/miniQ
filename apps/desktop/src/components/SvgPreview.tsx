import { useEffect, useRef, useState } from "react";
import { ImageInspector } from "./MediaPreview";

export function SvgPreview(props: {
  content: string;
  label: string;
  onError: (message: string) => void;
}) {
  const report = useRef(props.onError);
  report.current = props.onError;
  const [source, setSource] = useState<{
    content: string;
    url: string;
    size: { width: number; height: number };
  } | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([props.content], { type: "image/svg+xml" }),
    );
    // WebKit reports the CSS-constrained size as naturalWidth for an attached
    // SVG. Measure off-DOM so 100% zoom uses the file's intrinsic dimensions.
    const probe = new Image();
    probe.onload = () =>
      setSource({
        content: props.content,
        url,
        size: { width: probe.naturalWidth, height: probe.naturalHeight },
      });
    probe.onerror = () => report.current("SVG 图片解码失败");
    probe.src = url;
    return () => {
      probe.onload = null;
      probe.onerror = null;
      URL.revokeObjectURL(url);
    };
  }, [props.content]);
  return source?.content === props.content ? (
    <ImageInspector
      key={source.url}
      url={source.url}
      intrinsicSize={source.size}
      label={props.label}
      onError={props.onError}
    />
  ) : (
    <div className="diff-empty">正在读取 SVG...</div>
  );
}
