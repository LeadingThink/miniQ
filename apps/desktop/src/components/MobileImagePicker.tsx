import { Camera, ImagePlus, Images, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { isNativeMobileApp } from "../mobileRuntime";
import { pickMobileImage, type MobileImageSource } from "../mobileImagePicker";
import { useMobileBackButton } from "./MobileAppearanceSheet";

interface Props {
  disabled?: boolean;
  onImage: (file: File) => void | Promise<void>;
  onError?: (message: string) => void;
}

export function MobileImagePicker(props: Props) {
  const native = isNativeMobileApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<MobileImageSource | null>(null);
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
    if (file) void props.onImage(file);
  };

  const choose = async (source: MobileImageSource) => {
    if (props.disabled || busy) return;
    if (!native) {
      setOpen(false);
      (source === "camera" ? cameraInput : galleryInput).current?.click();
      return;
    }
    setBusy(source);
    try {
      const file = await pickMobileImage(source);
      if (file) await props.onImage(file);
      setOpen(false);
    } catch (error) {
      props.onError?.(error instanceof Error ? error.message : "图片选择失败，请重试");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="mobile-chat-image-button"
        aria-label="添加图片"
        title="添加图片"
        disabled={props.disabled}
        onClick={() => setOpen(true)}
      >
        <ImagePlus size={19} />
      </button>
      <input
        ref={galleryInput}
        className="mobile-chat-file-input"
        type="file"
        aria-label="附加图片"
        disabled={props.disabled}
        accept="image/png,image/jpeg,image/webp,image/gif"
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
              <h2 id={titleId}>添加图片</h2>
              <button type="button" className="mobile-chat-media-close" aria-label="关闭图片菜单" onClick={() => setOpen(false)}>
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
                <span><strong>{busy === "photos" ? "正在打开相册…" : "从相册选择"}</strong><small>选择设备中已有的图片</small></span>
              </button>
            </div>
            <button type="button" className="mobile-chat-media-cancel" onClick={() => setOpen(false)}>取消</button>
          </section>
        </div>
      )}
    </>
  );
}
