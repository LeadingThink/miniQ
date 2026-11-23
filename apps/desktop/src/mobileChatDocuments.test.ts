// @vitest-environment jsdom
import { expect, it } from "vitest";
import { MAX_MOBILE_DOCUMENT_BYTES, MAX_MOBILE_TEXT_BYTES, mobileAttachmentContent, readMobileAttachment } from "./mobileChatAttachments";

it("sends the full saved WeChat PDF with its original name as a file part", async () => {
  const bytes = "%PDF-1.7\nwhole original document";
  const file = new File([bytes], "微信合同.pdf", { type: "application/pdf" });
  const attachment = await readMobileAttachment(file);
  expect(attachment.kind).toBe("pdf");
  expect(mobileAttachmentContent("分析合同", attachment)).toEqual([
    { type: "text", text: "分析合同" },
    { type: "file", file: { filename: "微信合同.pdf", file_data: `data:application/pdf;base64,${btoa(bytes)}` } },
  ]);
});

it.each(["txt", "md", "csv", "json", "log"])("includes all UTF-8 text from saved %s files without truncation", async extension => {
  const text = "微信文件内容\n".repeat(10000);
  const attachment = await readMobileAttachment(new File([text], `记录.${extension}`, { type: "" }));
  expect(mobileAttachmentContent("", attachment)).toEqual([{ type: "text", text: `附件：记录.${extension}\n${text}` }]);
});

it("reads UTF-16 text with a BOM and rejects broken text encoding", async () => {
  const file = new File([new Uint8Array([0xff, 0xfe, 0x2d, 0x4e])], "记录.txt");
  expect(mobileAttachmentContent("", await readMobileAttachment(file))).toEqual([{ type: "text", text: "附件：记录.txt\n中" }]);
  await expect(readMobileAttachment(new File([new Uint8Array([0xff, 0xff])], "记录.txt"))).rejects.toThrow("编码");
});

it.each([
  ["合同.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 10, "转为 PDF"],
  ["合同.pdf", "application/pdf", MAX_MOBILE_DOCUMENT_BYTES + 1, "20 MiB"],
  ["记录.txt", "text/plain", MAX_MOBILE_TEXT_BYTES + 1, "1 MiB"],
  ["合同.pdf", "application/pdf", 0, "文件为空"],
])("rejects unsupported or oversized %s before reading", async (name, type, size, error) => {
  const file = new File(["test"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  await expect(readMobileAttachment(file)).rejects.toThrow(error);
});
