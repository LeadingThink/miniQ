const IMAGE_TYPES_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const SUPPORTED_IMAGE_TYPES = new Set(Object.values(IMAGE_TYPES_BY_EXTENSION));

/** A clipboard file's image type, inferred from its name when the WebView leaves `type` empty. */
function imageType(file: File): string | null {
  const type = file.type.toLowerCase();
  if (type) return type.startsWith("image/") ? type : null;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_TYPES_BY_EXTENSION[extension] ?? null;
}

/**
 * Files in a paste. WebViews expose them through `items`, `files`, or both,
 * sometimes with an empty MIME type; images then carry the type inferred from
 * the name so the saved attachment keeps its extension.
 *
 * Copying one image can offer several representations (PNG + TIFF on macOS).
 * Supported formats win in that case so a single screenshot is not attached
 * twice. Documents such as a PDF are always kept.
 */
export function clipboardFiles(data: Pick<DataTransfer, "items" | "files">): File[] {
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const candidates = fromItems.length > 0 ? fromItems : Array.from(data.files ?? []);
  const files = candidates.map((file) => {
    const type = imageType(file);
    return !type || file.type.toLowerCase() === type ? file : new File([file], file.name, { type });
  });
  const images = files.filter((file) => file.type.startsWith("image/"));
  const supported = images.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
  if (supported.length === 0 || supported.length === images.length) return files;
  return files.filter((file) => !file.type.startsWith("image/") || supported.includes(file));
}
