// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileAttachmentPicker } from "./MobileAttachmentPicker";

const capture = vi.hoisted(() => vi.fn());
const picker = vi.hoisted(() => ({ native: true, pick: vi.fn() }));
vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => picker.native }));
vi.mock("../mobilePhotoCapture", () => ({ captureMobilePhoto: capture }));
vi.mock("../mobileAttachmentPicker", () => ({ pickMobileAttachmentFile: picker.pick }));
vi.mock("./MobileAppearanceSheet", () => ({ useMobileBackButton: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); capture.mockReset(); picker.pick.mockReset(); picker.native = true; });

it("uses the shared original-media picker on native mobile and keeps the attachment when cancelled", async () => {
  const file = new File(["original video"], "clip.mp4", { type: "video/mp4" });
  picker.pick.mockResolvedValueOnce(file).mockResolvedValueOnce(null);
  const onAttachment = vi.fn();
  render(<MobileAttachmentPicker onAttachment={onAttachment} />);
  fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
  fireEvent.click(screen.getByRole("button", { name: "从相册选择" }));
  await waitFor(() => expect(onAttachment).toHaveBeenCalledWith(file));
  expect(picker.pick).toHaveBeenCalledOnce();
  expect(picker.pick).toHaveBeenCalledWith("photos");
  expect(capture).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
  fireEvent.click(screen.getByRole("button", { name: "从相册选择" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onAttachment).toHaveBeenCalledTimes(1);
});

it("selects saved WeChat documents through the native document picker and preserves cancellation", async () => {
  const file = new File(["%PDF-1.7\noriginal"], "合同.pdf", { type: "application/pdf" });
  picker.pick.mockResolvedValueOnce(file).mockResolvedValueOnce(null);
  const onAttachment = vi.fn();
  render(<MobileAttachmentPicker onAttachment={onAttachment} />);
  fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
  expect(screen.getByText(/先在微信中/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "上传微信文件" }));
  await waitFor(() => expect(onAttachment).toHaveBeenCalledWith(file));
  expect(picker.pick).toHaveBeenCalledWith("files");
  fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
  fireEvent.click(screen.getByRole("button", { name: "上传微信文件" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onAttachment).toHaveBeenCalledTimes(1);
});

it("opens an unrestricted single-file document input on the web", () => {
  picker.native = false;
  const onAttachment = vi.fn();
  render(<MobileAttachmentPicker onAttachment={onAttachment} />);
  const input = screen.getByLabelText<HTMLInputElement>("选择微信已保存的文件");
  const click = vi.spyOn(input, "click");
  expect(input.hasAttribute("accept")).toBe(false);
  expect(input.multiple).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
  fireEvent.click(screen.getByRole("button", { name: "上传微信文件" }));
  expect(click).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { files: [new File(["text"], "微信记录.txt")] } });
  expect(onAttachment).toHaveBeenCalledOnce();
  expect(picker.pick).not.toHaveBeenCalled();
});

it("reports a multi-file browser result without silently dropping any selected files", () => {
  picker.native = false;
  const onAttachment = vi.fn(), onError = vi.fn();
  render(<MobileAttachmentPicker onAttachment={onAttachment} onError={onError} />);
  fireEvent.change(screen.getByLabelText("选择微信已保存的文件"), {
    target: { files: [new File(["one"], "one.txt"), new File(["two"], "two.txt")] },
  });
  expect(onAttachment).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith("移动问答每次只能附加一个文件，请重新选择");
});

it("opens the mixed-media browser file input without requesting camera capture", () => {
  picker.native = false;
  const onAttachment = vi.fn();
  render(<MobileAttachmentPicker onAttachment={onAttachment} />);
  const input = screen.getByLabelText<HTMLInputElement>("附加照片或视频");
  const click = vi.spyOn(input, "click");
  expect(input.accept).toContain("video/mp4");
  expect(input.accept).toContain("video/quicktime");
  expect(input.accept).toContain("image/jpeg");
  expect(input.hasAttribute("capture")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
  fireEvent.click(screen.getByRole("button", { name: "从相册选择" }));
  expect(click).toHaveBeenCalledOnce();
  expect(capture).not.toHaveBeenCalled();
  expect(picker.pick).not.toHaveBeenCalled();
  const file = new File(["original video"], "clip.mp4", { type: "video/mp4" });
  fireEvent.change(input, { target: { files: [file] } });
  expect(onAttachment).toHaveBeenCalledWith(file);
  expect(input.value).toBe("");
  // Cancelling a later selection must not remove the current attachment.
  fireEvent.change(input, { target: { files: [] } });
  expect(onAttachment).toHaveBeenCalledTimes(1);
});

it("keeps native photo capture and reports camera failures", async () => {
  const file = new File(["photo"], "camera.jpg", { type: "image/jpeg" });
  capture.mockResolvedValueOnce(file).mockRejectedValueOnce(new Error("相机权限未开启"));
  const onAttachment = vi.fn();
  const onError = vi.fn();
  render(<MobileAttachmentPicker onAttachment={onAttachment} onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
  fireEvent.click(screen.getByRole("button", { name: "拍照" }));
  await waitFor(() => expect(onAttachment).toHaveBeenCalledWith(file));
  fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
  fireEvent.click(screen.getByRole("button", { name: "拍照" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("相机权限未开启"));
});
