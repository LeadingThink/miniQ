import { Camera, ImagePlus, Images, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { isNativeMobileApp } from "../mobileRuntime";
import { captureMobilePhoto } from "../mobilePhotoCapture";
import { pickMobileMediaFile } from "../mobileMediaPicker";
import { MOBILE_CHAT_MEDIA_ACCEPT } from "../mobileChatMedia";
import { useMobileBackButton } from "./MobileAppearanceSheet";

interface Props {
  disabled?: boolean;
  onMedia: (file: File) => void | Promise<void>;
  onError?: (message: string) => void;
}

export function MobileMediaPicker(props: Props) {
  const native = isNativeMobileApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"camera" | "photos" | null>(null);
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

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
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    setOpen(false);
    if (file) void props.onMedia(file);
  };

  const choose = async (source: "camera" | "photos") => {
    if (props.disabled || busy) return;
    if (!native) {
      setOpen(false);
      (source === "camera" ? cameraInput : galleryInput).current?.click();
      return;
    }
    setBusy(source);
    try {
      const file = await (source === "camera" ? captureMobilePhoto() : pickMobileMediaFile());
      if (file) await props.onMedia(file);
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
        aria-label="添加照片或视频"
        title="添加照片或视频"
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
              <h2 id={titleId}>添加照片或视频</h2>
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
            </div>
            <button type="button" className="mobile-chat-media-cancel" onClick={() => setOpen(false)}>取消</button>
          </section>
        </div>
      )}
    </>
  );
}
