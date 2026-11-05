import { X } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import "./ImageLightbox.css";

export function ImageLightbox(props: {
  open: boolean;
  src: string;
  alt: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      title={props.alt}
      onClose={props.onClose}
      className="image-lightbox"
    >
      <button
        type="button"
        className="image-lightbox-close"
        aria-label="关闭图片预览"
        title="关闭"
        data-autofocus
        onClick={props.onClose}
      >
        <X size={20} />
      </button>
      <img className="image-lightbox-image" src={props.src} alt={props.alt} />
    </Dialog>
  );
}