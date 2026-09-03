import type { ImageAttachment, UserMessageInput } from "./types";

export function canSendComposer(
  draft: string,
  attachments: string[],
  images: ImageAttachment[] = [],
): boolean {
  return draft.trim().length > 0 || attachments.length > 0 || images.length > 0;
}

export function buildComposerMessage(
  draft: string,
  attachments: string[],
  images: ImageAttachment[] = [],
): UserMessageInput {
  const content = draft.trim();
  if (attachments.length === 0) return { content, images };
  const attachmentBlock = `[用户附加的本地文件]\n${attachments
    .map((path) => `- ${path}`)
    .join("\n")}`;
  return {
    content: content ? `${content}\n\n${attachmentBlock}` : attachmentBlock,
    images,
  };
}

export function isComposerSendKey(
  key: string,
  shiftKey: boolean,
  isComposing: boolean,
): boolean {
  return key === "Enter" && !shiftKey && !isComposing;
}
