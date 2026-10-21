/**
 * Upper bound for one image accepted from the clipboard, a drag-and-drop, or
 * the mobile picker. Kept in one place so the desktop shell, the web entry and
 * the user-facing message cannot drift apart.
 */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export const MAX_IMAGE_LABEL = `${MAX_IMAGE_BYTES / (1024 * 1024)} MB`;

export function imageTooLarge(): Error {
  return new Error(`图片不能超过 ${MAX_IMAGE_LABEL}`);
}
