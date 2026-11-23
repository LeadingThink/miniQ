// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileChat } from "./MobileChat";
import { MOBILE_CHAT_STORAGE_KEY } from "../mobileChatData";
import { MAX_MOBILE_VIDEO_BYTES } from "../mobileChatMedia";

vi.mock("./Md", () => ({ Md: ({ children }: { children: string }) => <div>{children}</div> }));
const catalog = { data: [{ id: "video-chat-model", model_type: "chat" }] };
const video = () => new File(["whole original video"], "phone.mp4", { type: "video/mp4" });
const modelRequest = (url: unknown) => String(url).endsWith("/models");
function installFetch(failure = false) {
  const fetcher = vi.fn((url: unknown, _init?: RequestInit) => Promise.resolve(modelRequest(url)
    ? new Response(JSON.stringify(catalog))
    : failure ? new Response(JSON.stringify({ error: { message: "所选模型不支持视频输入" } }), { status: 400 })
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

it("sends a video alone and preserves it for retry when the model rejects video input", async () => {
  const fetcher = installFetch(true);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("video-chat-model");
  fireEvent.change(screen.getByLabelText("附加照片或视频"), { target: { files: [video()] } });
  await screen.findByText("phone.mp4");
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("所选模型不支持视频输入");
  expect(screen.getByLabelText("已附加视频")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新回答" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => !modelRequest(url))).toHaveLength(2));
  const bodies = fetcher.mock.calls.filter(([url]) => !modelRequest(url)).map(([, init]) => JSON.parse(init?.body as string));
  expect(bodies[0].messages).toEqual(bodies[1].messages);
  expect(bodies[0].messages[0].content[0].type).toBe("video_url");
  await screen.findByText("所选模型不支持视频输入");
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
