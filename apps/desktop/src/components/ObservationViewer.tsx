import { useEffect, useRef } from "react";
import { Download, X } from "lucide-react";
import { ImageInspector } from "./MediaPreview";
import "./ObservationViewer.css";

export function ObservationViewer(props: {
  url: string; title: string; width: number; height: number; filename: string;
  onClose: () => void; onError: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="observation-viewer" aria-label={props.title}
    onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
    <header><strong>{props.title}</strong>
      <a href={props.url} download={props.filename} aria-label="下载原始截图"><Download size={18} /></a>
      <button type="button" aria-label="关闭截图预览" onClick={props.onClose}><X size={20} /></button>
    </header>
    <ImageInspector url={props.url} label={props.title} intrinsicSize={{ width: props.width, height: props.height }} onError={props.onError} />
  </dialog>;
}
