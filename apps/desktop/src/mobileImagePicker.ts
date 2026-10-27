import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";

export type MobileImageSource = "camera" | "photos";

/** Capture or select one image through Capacitor and expose it to the shared reader. */
export async function pickMobileImage(source: MobileImageSource): Promise<File | null> {
  if (source === "camera") {
    const permission = await Camera.requestPermissions({ permissions: ["camera"] });
    if (permission.camera !== "granted") {
      throw new Error("相机权限未开启，请在系统设置中允许 miniQ 使用相机");
    }
  }

  try {
    const photo = await Camera.getPhoto({
      source: source === "camera" ? CameraSource.Camera : CameraSource.Photos,
      resultType: CameraResultType.Uri,
      quality: 90,
      width: 2048,
      height: 2048,
      correctOrientation: true,
    });
    if (!photo.webPath) throw new Error("无法读取图片");
    const response = await fetch(photo.webPath);
    if (!response.ok) throw new Error("无法读取图片");
    const blob = await response.blob();
    const type = imageMimeType(blob.type, photo.format);
    if (!type) throw new Error("拍摄的图片格式不受支持");
    const extension = type === "image/jpeg" ? "jpg" : type.slice("image/".length);
    const prefix = source === "camera" ? "photo" : "image";
    return new File([blob], `miniq-${prefix}-${Date.now()}.${extension}`, { type });
  } catch (error) {
    if (isPickerCancellation(error)) return null;
    throw error;
  }
}

function imageMimeType(blobType: string, format: string): string | null {
  const normalized = blobType.toLowerCase();
  if (/^image\/(png|jpe?g|webp|gif)$/.test(normalized)) {
    return normalized === "image/jpg" ? "image/jpeg" : normalized;
  }
  const suffix = format.toLowerCase() === "jpg" ? "jpeg" : format.toLowerCase();
  return /^(png|jpeg|webp|gif)$/.test(suffix) ? `image/${suffix}` : null;
}

function isPickerCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cancel|取消/i.test(message);
}
