const IMAGE_TYPES_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const SUPPORTED_TYPES = new Set(Object.values(IMAGE_TYPES_BY_EXTENSION));

/** A clipboard file's image type, inferred from its name when the WebView leaves `type` empty. */
function imageType(file: File): string | null {
  const type = file.type.toLowerCase();
  if (type) return type.startsWith("image/") ? type : null;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_TYPES_BY_EXTENSION[extension] ?? null;
}

/**
 * Images in a paste. WebViews expose them through `items`, `files`, or both,
 * sometimes with an empty MIME type. Each returned file carries its type.
 * When the clipboard offers several representations, supported formats win;
 * otherwise every image is returned so the caller can report the format.
 */
export function clipboardImages(data: Pick<DataTransfer, "items" | "files">): File[] {
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const candidates = fromItems.length > 0 ? fromItems : Array.from(data.files ?? []);
  const images = candidates.flatMap((file) => {
    const type = imageType(file);
    if (!type) return [];
    return [file.type.toLowerCase() === type ? file : new File([file], file.name, { type })];
  });
  const supported = images.filter((file) => SUPPORTED_TYPES.has(file.type));
  return supported.length > 0 ? supported : images;
}
