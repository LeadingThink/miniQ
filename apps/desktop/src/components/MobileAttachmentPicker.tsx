import { Camera, FileText, ImagePlus, Images, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { isNativeMobileApp } from "../mobileRuntime";
import { captureMobilePhoto } from "../mobilePhotoCapture";
import { pickMobileAttachmentFile } from "../mobileAttachmentPicker";
import { MOBILE_CHAT_MEDIA_ACCEPT } from "../mobileChatAttachments";
import { WECHAT_FILE_GUIDANCE } from "../wechatFileUpload";
import { useMobileBackButton } from "./MobileAppearanceSheet";

interface Props {
  disabled?: boolean;
  onAttachment: (file: File) => void | Promise<void>;
  onError?: (message: string) => void;
}

export function MobileAttachmentPicker(props: Props) {
  const native = isNativeMobileApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"camera" | "photos" | "files" | null>(null);
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);

  useMobileBackButton(() => setOpen(false), open && native);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".mobile-chat-media-action")?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [open]);

  const handleInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    setOpen(false);
    if (files.length > 1) {
      props.onError?.("移动问答每次只能附加一个文件，请重新选择");
      return;
    }
    if (files.length) void props.onAttachment(files[0]);
  };

  const choose = async (source: "camera" | "photos" | "files") => {
    if (props.disabled || busy) return;
    if (!native) {
      setOpen(false);
      (source === "camera" ? cameraInput : source === "files" ? documentInput : galleryInput).current?.click();
      return;
    }
    setBusy(source);
    try {
      const file = await (source === "camera" ? captureMobilePhoto() : pickMobileAttachmentFile(source));
      if (file) await props.onAttachment(file);
      setOpen(false);
    } catch (error) {
      props.onError?.(error instanceof Error ? error.message : "附件选择失败，请重试");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="mobile-chat-media-button"
        aria-label="添加附件"
        title="添加附件"
        disabled={props.disabled}
        onClick={() => setOpen(true)}
      >
        <ImagePlus size={19} />
      </button>
      <input
        ref={galleryInput}
        className="mobile-chat-file-input"
        type="file"
        aria-label="附加照片或视频"
        disabled={props.disabled}
        accept={MOBILE_CHAT_MEDIA_ACCEPT}
        onChange={handleInput}
      />
      <input
        ref={documentInput}
        className="mobile-chat-file-input"
        type="file"
        aria-label="选择微信已保存的文件"
        disabled={props.disabled}
        onChange={handleInput}
      />
      <input
        ref={cameraInput}
        className="mobile-chat-file-input"
        type="file"
        aria-label="拍照"
        disabled={props.disabled}
        accept="image/*"
        capture="environment"
        onChange={handleInput}
      />
      {open && (
        <div
          className="mobile-chat-media-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section className="mobile-chat-media-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <header className="mobile-chat-media-header">
              <h2 id={titleId}>添加附件</h2>
              <button type="button" className="mobile-chat-media-close" aria-label="关闭附件菜单" onClick={() => setOpen(false)}>
                <X size={19} />
              </button>
            </header>
            <div className="mobile-chat-media-actions">
              <button type="button" className="mobile-chat-media-action" aria-label="拍照" disabled={Boolean(busy)} onClick={() => void choose("camera")}>
                <span className="mobile-chat-media-action-icon"><Camera size={21} /></span>
                <span><strong>{busy === "camera" ? "正在打开相机…" : "拍照"}</strong><small>使用手机相机拍摄图片</small></span>
              </button>
              <button type="button" className="mobile-chat-media-action" aria-label="从相册选择" disabled={Boolean(busy)} onClick={() => void choose("photos")}>
                <span className="mobile-chat-media-action-icon"><Images size={21} /></span>
                <span><strong>{busy === "photos" ? "正在读取附件…" : "从相册选择"}</strong><small>选择一张照片或一个视频原件，视频限 64 MiB</small></span>
              </button>
              <button type="button" className="mobile-chat-media-action" aria-label="上传微信文件" disabled={Boolean(busy)} onClick={() => void choose("files")}>
                <span className="mobile-chat-media-action-icon"><FileText size={21} /></span>
                <span><strong>{busy === "files" ? "正在读取文件…" : "上传微信文件"}</strong><small>选择已保存的 PDF（20 MiB 内）或文本文件（1 MiB 内）</small></span>
              </button>
            </div>
            <p className="mobile-chat-media-hint">{WECHAT_FILE_GUIDANCE}</p>
            <button type="button" className="mobile-chat-media-cancel" onClick={() => setOpen(false)}>取消</button>
          </section>
        </div>
      )}
    </>
  );
}
