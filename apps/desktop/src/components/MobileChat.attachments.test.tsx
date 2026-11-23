// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileChat } from "./MobileChat";
import { MOBILE_CHAT_STORAGE_KEY } from "../mobileChatData";
import { MAX_MOBILE_VIDEO_BYTES } from "../mobileChatAttachments";

vi.mock("./Md", () => ({ Md: ({ children }: { children: string }) => <div>{children}</div> }));
const catalog = { data: [{ id: "video-chat-model", model_type: "chat" }] };
const video = () => new File(["whole original video"], "phone.mp4", { type: "video/mp4" });
const modelRequest = (url: unknown) => String(url).endsWith("/models");
function installFetch(failure = false) {
  const fetcher = vi.fn((url: unknown, _init?: RequestInit) => Promise.resolve(modelRequest(url)
    ? new Response(JSON.stringify(catalog))
    : failure ? new Response(JSON.stringify({ error: { message: "所选模型不支持此附件" } }), { status: 400 })
      : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "视频回答" }, finish_reason: "stop" }] })}\n\n`)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("sends an original video without a desktop connection, restores it and includes it in follow-up context", async () => {
  const fetcher = installFetch();
  const view = render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("video-chat-model");
  fireEvent.change(screen.getByLabelText("附加照片或视频"), { target: { files: [video()] } });
  await screen.findByText("phone.mp4");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "分析这个视频" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("视频回答");
  const content = [
    { type: "text", text: "分析这个视频" },
    { type: "video_url", video_url: { url: `data:video/mp4;base64,${btoa("whole original video")}` } },
  ];
  const requests = () => fetcher.mock.calls.filter(([url]) => !modelRequest(url));
  expect(JSON.parse(requests()[0][1]?.body as string).messages).toEqual([{ role: "user", content }]);
  const preview = screen.getByLabelText("已附加视频");
  expect(preview.tagName).toBe("VIDEO");
  expect(preview.hasAttribute("controls")).toBe(true);
  expect(screen.queryByAltText("已附加图片")).toBeNull();
  expect(JSON.parse(localStorage.getItem(MOBILE_CHAT_STORAGE_KEY)!)[0].content).toEqual(content);
  view.unmount();
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("video-chat-model");
  expect(screen.getByLabelText("已附加视频").getAttribute("src")).toBe(content[1].video_url?.url);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "继续分析" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(requests()).toHaveLength(2));
  expect(JSON.parse(requests()[1][1]?.body as string).messages).toEqual([
    { role: "user", content }, { role: "assistant", content: "视频回答" }, { role: "user", content: "继续分析" },
  ]);
  await waitFor(() => expect(screen.getAllByText("视频回答")).toHaveLength(2));
});

it.each(["video", "pdf"] as const)("sends a %s alone and preserves it for retry when the model rejects it", async kind => {
  const fetcher = installFetch(true);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("video-chat-model");
  const file = kind === "video" ? video() : new File(["%PDF-1.7\noriginal"], "合同.pdf", { type: "application/pdf" });
  fireEvent.change(screen.getByLabelText(kind === "video" ? "附加照片或视频" : "选择微信已保存的文件"), { target: { files: [file] } });
  await screen.findByText(file.name);
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("所选模型不支持此附件");
  expect(screen.getByLabelText(kind === "video" ? "已附加视频" : "已附加文件")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新回答" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => !modelRequest(url))).toHaveLength(2));
  const bodies = fetcher.mock.calls.filter(([url]) => !modelRequest(url)).map(([, init]) => JSON.parse(init?.body as string));
  expect(bodies[0].messages).toEqual(bodies[1].messages);
  expect(bodies[0].messages[0].content[0].type).toBe(kind === "video" ? "video_url" : "file");
  await screen.findByText("所选模型不支持此附件");
});

it("leaves a selected video and draft intact on cancellation or invalid replacement and allows removal", async () => {
  installFetch();
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("video-chat-model");
  const input = screen.getByLabelText("附加照片或视频");
  fireEvent.change(input, { target: { files: [video()] } });
  await screen.findByText("phone.mp4");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "保留草稿" } });
  fireEvent.change(input, { target: { files: [] } });
  const oversized = video();
  Object.defineProperty(oversized, "size", { value: MAX_MOBILE_VIDEO_BYTES + 1 });
  fireEvent.change(input, { target: { files: [oversized] } });
  await screen.findByText("视频不能超过 64 MiB");
  expect(screen.getByText("phone.mp4")).toBeTruthy();
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("保留草稿");
  fireEvent.click(screen.getByRole("button", { name: "移除视频" }));
  expect(screen.queryByText("phone.mp4")).toBeNull();
});

it("sends a saved WeChat PDF, restores its filename and preserves the original in follow-up context", async () => {
  const fetcher = installFetch();
  const view = render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("video-chat-model");
  const bytes = "%PDF-1.7\noriginal WeChat PDF";
  const file = new File([bytes], "微信合同.pdf", { type: "application/pdf" });
  fireEvent.change(screen.getByLabelText("选择微信已保存的文件"), { target: { files: [file] } });
  await screen.findByText("微信合同.pdf");
  expect(screen.getByText("请使用支持 PDF 文件输入的模型。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("视频回答");
  const content = [{ type: "file", file: { filename: file.name, file_data: `data:application/pdf;base64,${btoa(bytes)}` } }];
  const requests = () => fetcher.mock.calls.filter(([url]) => !modelRequest(url));
  expect(JSON.parse(requests()[0][1]?.body as string).messages).toEqual([{ role: "user", content }]);
  expect(screen.getByLabelText("已附加文件").textContent).toBe(file.name);
  view.unmount();
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("video-chat-model");
  expect(screen.getByLabelText("已附加文件").textContent).toBe(file.name);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "继续分析合同" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(requests()).toHaveLength(2));
  expect(JSON.parse(requests()[1][1]?.body as string).messages[0]).toEqual({ role: "user", content });
  await waitFor(() => expect(screen.getAllByText("视频回答")).toHaveLength(2));
});

it("sends the complete text export without a desktop connection", async () => {
  const fetcher = installFetch();
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("video-chat-model");
  const text = "完整微信文本\n".repeat(1000);
  fireEvent.change(screen.getByLabelText("选择微信已保存的文件"), {
    target: { files: [new File([text], "聊天记录.txt", { type: "text/plain" })] },
  });
  await screen.findByText("聊天记录.txt");
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("视频回答");
  const request = fetcher.mock.calls.find(([url]) => !modelRequest(url));
  expect(JSON.parse(request![1]?.body as string).messages[0].content).toEqual([
    { type: "text", text: `附件：聊天记录.txt\n${text}` },
  ]);
});

it("keeps the selected PDF and draft when a replacement is unsupported or cancelled", async () => {
  installFetch();
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("video-chat-model");
  const input = screen.getByLabelText("选择微信已保存的文件");
  fireEvent.change(input, { target: { files: [new File(["%PDF-1.7"], "合同.pdf", { type: "application/pdf" })] } });
  await screen.findByText("合同.pdf");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "分析合同" } });
  fireEvent.change(input, { target: { files: [] } });
  fireEvent.change(input, { target: { files: [new File(["word"], "合同.docx")] } });
  await screen.findByText(/其他微信文件请转为 PDF/);
  expect(screen.getByText("合同.pdf")).toBeTruthy();
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("分析合同");
  fireEvent.click(screen.getByRole("button", { name: "移除文件" }));
  expect(screen.queryByText("合同.pdf")).toBeNull();
});
