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

it("shows errors and retries", async () => {
  const client = {call:vi.fn().mockRejectedValueOnce(new Error("连接已断开")).mockResolvedValue(response)} as unknown as RpcClient;
  render(<ComputerObservation call={call} client={client} />);
  expect((await screen.findByRole("alert")).textContent).toContain("连接已断开");
  fireEvent.click(screen.getByRole("button",{name:"重新加载截图"}));
  await screen.findByAltText("操作后的网页截图");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not retain a late response after the panel closes", async () => {
  let complete!: (value: typeof response) => void;
  const client = {call:vi.fn(() => new Promise(resolve => {complete = resolve;}))} as unknown as RpcClient;
  const view = render(<ComputerObservation call={call} client={client} />);
  await waitFor(() => expect(client.call).toHaveBeenCalled());
  view.unmount();
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
  await waitFor(() => expect(client.call).toHaveBeenLastCalledWith("observation.read",{sessionId:"session-1",toolCallId:"call-1",offset:0,imageIndex:1}));
  await screen.findByAltText("PDF 第 5 页");
  expect(URL.revokeObjectURL).toHaveBeenCalled();
  expect(screen.getByRole("button",{name:"下一页"}).hasAttribute("disabled")).toBe(true);
});
