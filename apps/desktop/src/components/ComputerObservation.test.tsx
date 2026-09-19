// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerObservation } from "./ComputerObservation";
import type { ToolCall } from "../types";
import type { RpcClient } from "../rpc";

const call: ToolCall = { id:"call-1", sessionId:"session-1", toolName:"browser_automation", input:{}, status:"succeeded", createdAt:"2026-09-06T01:00:00Z",
  output:{screenshot:{id:"aa8091e1-3bf0-4b0f-b699-260f2ac9e081",width:1280,height:820,bytes:3}} };
const response = {offset:0,nextOffset:3,totalBytes:3,done:true,mimeType:"image/png",base64:"YWJj"};
beforeEach(() => { URL.createObjectURL = vi.fn(() => "blob:test"); URL.revokeObjectURL = vi.fn(); });
afterEach(cleanup);

it("loads lazily, supports original size and releases its blob on unmount", async () => {
  const client = {call:vi.fn().mockResolvedValue(response)} as unknown as RpcClient;
  const view = render(<ComputerObservation call={call} client={client} />);
  await screen.findByAltText("操作后的网页截图");
  fireEvent.click(screen.getByRole("button",{name:"原始尺寸"}));
  expect(screen.getByRole("button",{name:"适应宽度"}).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("link",{name:"下载截图"}).getAttribute("href")).toBe("blob:test");
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
});

it("offers to open the observed browser URL in the right-side workbench", async () => {
  const client = {call:vi.fn().mockResolvedValue(response)} as unknown as RpcClient;
  const open = vi.fn();
  window.addEventListener("miniq:open-browser", open);
  render(<ComputerObservation call={{...call, input:{action:"open", url:"https://example.test"}}} client={client} />);
  await screen.findByAltText("操作后的网页截图");
  fireEvent.click(screen.getByRole("button", {name:"在右侧内置浏览器打开"}));
  expect(open).toHaveBeenCalledTimes(1);
  expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({url:"https://example.test"});
  window.removeEventListener("miniq:open-browser", open);
});

it("reopens the exact observed page and uses its final URL after redirects", async () => {
  const client = {call:vi.fn().mockResolvedValue(response)} as unknown as RpcClient;
  const open = vi.fn();
  window.addEventListener("miniq:open-browser", open);
  try {
    render(<ComputerObservation call={{...call, input:{action:"open", url:"https://before.test/"},
      output:{...call.output as object, url:"https://after.test/form", tabId:"live-view-id"}}} client={client} />);
    await screen.findByAltText("操作后的网页截图");
    fireEvent.click(screen.getByRole("button", {name:"在右侧内置浏览器打开"}));
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({url:"https://after.test/form", tabId:"live-view-id"});
  } finally {
    window.removeEventListener("miniq:open-browser", open);
  }
});

it("identifies an app-scoped screenshot without presenting desktop takeover or browser controls", async () => {
  const client = {call:vi.fn().mockResolvedValue(response)} as unknown as RpcClient;
  render(<ComputerObservation call={{...call, toolName:"app_automation", output:{...call.output as object,
    target:{windowId:42,pid:17,appName:"网易邮箱大师",title:"撰写邮件"},interactionMode:"background-app"}}} client={client} />);
  await screen.findByAltText("网易邮箱大师窗口截图");
  expect(screen.getByText("应用观察 · 网易邮箱大师").title).toBe("撰写邮件");
  expect(screen.queryByText("桌面观察")).toBeNull();
  expect(screen.queryByRole("button", {name:"在右侧内置浏览器打开"})).toBeNull();
});

it("shows errors and retries", async () => {
  const client = {call:vi.fn().mockRejectedValueOnce(new Error("连接已断开")).mockResolvedValue(response)} as unknown as RpcClient;
  render(<ComputerObservation call={call} client={client} />);
  expect((await screen.findByRole("alert")).textContent).toContain("连接已断开");
  fireEvent.click(screen.getByRole("button",{name:"重新加载截图"}));
  await screen.findByAltText("操作后的网页截图");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows dispatched actions that still need verification without retrying them", () => {
  const client = {call:vi.fn()} as unknown as RpcClient;
  render(<ComputerObservation call={{...call, toolName:"computer_use", output:{
    actionDispatched:true,
    observationError:"screen capture failed",
    nextAction:"Call screenshot; do not repeat the input.",
  }}} client={client} />);
  expect(screen.getByRole("status").textContent).toContain("动作已发出，结果待核验");
  expect(screen.getByRole("status").textContent).toContain("screen capture failed");
  expect(screen.getByRole("status").textContent).toContain("不要仅因观察失败而重复该动作");
  expect(client.call).not.toHaveBeenCalled();
});

it("does not retain a late response after the panel closes", async () => {
  let complete!: (value: typeof response) => void;
  const client = {call:vi.fn(() => new Promise(resolve => {complete = resolve;}))} as unknown as RpcClient;
  const view = render(<ComputerObservation call={call} client={client} />);
  await waitFor(() => expect(client.call).toHaveBeenCalled());
  const signal = vi.mocked(client.call).mock.calls[0][2]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { complete(response); });
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("loads only the selected PDF page and revokes the previous image", async () => {
  const client = {call:vi.fn().mockResolvedValue(response)} as unknown as RpcClient;
  const screenshot = (call.output as {screenshot: object}).screenshot;
  const pdfCall = {...call, toolName:"view_pdf", output:{pages:[{page:2,screenshot},{page:5,screenshot:{...screenshot,id:"bb8091e1-3bf0-4b0f-b699-260f2ac9e081"}}]}};
  render(<ComputerObservation call={pdfCall} client={client} />);
  await screen.findByAltText("PDF 第 2 页");
  expect(client.call).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button",{name:"下一页"}));
  await waitFor(() => expect(client.call).toHaveBeenLastCalledWith("observation.read",{sessionId:"session-1",toolCallId:"call-1",offset:0,imageIndex:1},{signal:expect.any(AbortSignal)}));
  await screen.findByAltText("PDF 第 5 页");
  expect(URL.revokeObjectURL).toHaveBeenCalled();
  expect(screen.getByRole("button",{name:"下一页"}).hasAttribute("disabled")).toBe(true);
});

it("uses the loaded screenshot for fullscreen zoom and closes without downloading again", async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.setAttribute("open", ""); });
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) { this.removeAttribute("open"); });
  const client = { mode: "remote", call: vi.fn().mockResolvedValue(response) } as unknown as RpcClient;
  render(<ComputerObservation client={client} call={{ ...call, input: { url: "https://example.test/form" } }} />);
  await screen.findByAltText("操作后的网页截图");
  expect(screen.queryByRole("button", { name: "在右侧内置浏览器打开" })).toBeNull();
  expect(screen.getByRole("link", { name: "在本机浏览器打开" }).getAttribute("href")).toBe("https://example.test/form");
  fireEvent.click(screen.getByRole("button", { name: "全屏查看截图" }));
  expect(screen.getByRole("dialog").textContent).toContain("浏览器观察");
  fireEvent.click(screen.getByRole("button", { name: "关闭截图预览" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(client.call).toHaveBeenCalledTimes(1);
});
