import { useEffect, useState } from "react";
import { ImageInspector } from "./MediaPreview";

export function SvgPreview(props: {
  content: string;
  label: string;
  onError: (message: string) => void;
}) {
  const [source, setSource] = useState<{ content: string; url: string } | null>(
    null,
  );
  useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([props.content], { type: "image/svg+xml" }),
    );
    setSource({ content: props.content, url });
    return () => URL.revokeObjectURL(url);
  }, [props.content]);
  return source?.content === props.content ? (
    <ImageInspector
      url={source.url}
      label={props.label}
      onError={props.onError}
    />
  ) : null;
}
