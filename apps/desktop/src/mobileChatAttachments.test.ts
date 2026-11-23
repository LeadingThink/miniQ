// @vitest-environment jsdom
import { expect, it } from "vitest";
import { MAX_IMAGE_BYTES } from "./imageLimits";
import { MAX_MOBILE_VIDEO_BYTES, mobileAttachmentContent, readMobileAttachment } from "./mobileChatAttachments";

it.each([
  ["clip.mp4", "video/mp4", "video/mp4"],
  ["clip.mov", "video/quicktime", "video/quicktime"],
  ["clip.webm", "video/webm", "video/webm"],
  ["clip.MOV", "", "video/quicktime"],
  ["clip.mp4", "application/octet-stream", "video/mp4"],
  ["clip.m4v", "video/x-m4v", "video/mp4"],
])("reads the entire original video %s (%s) without conversion", async (name, type, expected) => {
  const bytes = new Uint8Array(Array.from({ length: 300_001 }, (_, index) => index % 256));
  const media = await readMobileAttachment(new File([bytes], name, { type }));
  expect(media).toMatchObject({ kind: "video", name });
  if (media.kind !== "video") throw new Error("video expected");
  expect(media.dataUrl.startsWith(`data:${expected};base64,`)).toBe(true);
  expect(Buffer.from(media.dataUrl.split(",")[1], "base64")).toEqual(Buffer.from(bytes));
  expect(mobileAttachmentContent("请分析视频", media)).toEqual([
    { type: "text", text: "请分析视频" }, { type: "video_url", video_url: { url: media.dataUrl } },
  ]);
});

it("keeps the image content contract and supports a video without accompanying text", async () => {
  const image = await readMobileAttachment(new File(["original"], "photo.png", { type: "image/png" }));
  if (image.kind !== "image") throw new Error("image expected");
  expect(mobileAttachmentContent("", image)).toEqual([{ type: "image_url", image_url: { url: image.dataUrl, detail: "auto" } }]);
  const video = await readMobileAttachment(new File(["original"], "clip.mp4", { type: "video/mp4" }));
  if (video.kind !== "video") throw new Error("video expected");
  expect(mobileAttachmentContent("", video)).toEqual([{ type: "video_url", video_url: { url: video.dataUrl } }]);
  expect(mobileAttachmentContent("纯文字", null)).toBe("纯文字");
});

it.each([
  ["clip.mp4", "video/mp4", MAX_MOBILE_VIDEO_BYTES + 1, "视频不能超过 64 MiB"],
  ["photo.png", "image/png", MAX_IMAGE_BYTES + 1, "图片不能超过"],
  ["clip.mp4", "video/mp4", 0, "所选文件为空"],
  ["fake.mp4", "application/pdf", 5, "仅支持"],
])("rejects invalid %s before allocating a data URL", async (name, type, size, error) => {
  const file = new File(["test"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  await expect(readMobileAttachment(file)).rejects.toThrow(error);
});
