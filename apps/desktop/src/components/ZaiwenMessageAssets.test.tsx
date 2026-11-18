// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ZaiwenMessageAssets } from "./ZaiwenMessageAssets";
import { Md } from "./Md";
import { MarkdownLocalFilesContext } from "../markdownPolicy";
import type { ZaiwenMessage } from "../zaiwenHistory";

function Message({ message, onOpenSite }: { message: ZaiwenMessage; onOpenSite: () => void }) {
  return <MarkdownLocalFilesContext.Provider value={false}><Md>{message.content}</Md>
    <ZaiwenMessageAssets message={message} onOpenSite={onOpenSite} /></MarkdownLocalFilesContext.Provider>;
}

afterEach(cleanup);

it("renders cloud Markdown and attachments without allowing local file links or raw HTML", () => {
  const { container } = render(<Message onOpenSite={() => {}} message={{
    id: "message", role: "assistant", created: 1700000000,
    content: "**回答**\n\n[网站](https://example.test/) [本地文件](file:///private/test) [目录](//host/private) [脚本](javascript:alert) [凭证](https://user:password@example.test/) ` /private/test.txt `\n\n<script>alert(1)</script>\n\n![示意图](https://example.test/image.png)",
    assets: [
      { name: "报告.pdf", format: "application/pdf", url: "https://example.test/report.pdf" },
      { name: "不安全链接", url: "javascript:alert(1)" },
    ],
  }} />);
  expect(screen.getByText("回答").tagName).toBe("STRONG");
  expect(screen.getByRole("link", { name: "报告.pdf" }).getAttribute("href")).toBe("https://example.test/report.pdf");
  expect(screen.queryByRole("link", { name: "本地文件" })).toBeNull();
  expect(screen.queryByText("不安全链接")).toBeNull();
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("[data-file-path]")).toBeNull();
  for (const name of ["目录", "脚本", "凭证"]) expect(screen.queryByRole("link", { name })).toBeNull();
  expect(screen.getByRole("img", { name: "示意图" }).getAttribute("src")).toBe("https://example.test/image.png");
});

it("offers the main site for rich content instead of silently hiding it", () => {
  render(<Message onOpenSite={() => {}} message={{ id: "rich", role: "assistant", created: 1700000000,
    content: "作品已生成", type: "pptx", ppt_result: "opaque-work-id" }} />);
  expect(screen.getByText("作品已生成")).toBeTruthy();
  expect(screen.getByRole("button", { name: "在主站查看完整结果" })).toBeTruthy();
});

it("offers the main site when an attachment has no directly accessible URL", () => {
  render(<Message onOpenSite={() => {}} message={{ id: "file", role: "user", created: 1700000000,
    content: "查看附件", type: "text", assets: [{ id: "opaque-file", name: "记录.pdf" }] }} />);
  expect(screen.getByRole("button", { name: "在主站查看完整结果" })).toBeTruthy();
});
