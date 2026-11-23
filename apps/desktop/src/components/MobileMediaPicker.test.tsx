// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileMediaPicker } from "./MobileMediaPicker";

const capture = vi.hoisted(() => vi.fn());
const picker = vi.hoisted(() => ({ native: true, pick: vi.fn() }));
vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => picker.native }));
vi.mock("../mobilePhotoCapture", () => ({ captureMobilePhoto: capture }));
vi.mock("../mobileMediaPicker", () => ({ pickMobileMediaFile: picker.pick }));
vi.mock("./MobileAppearanceSheet", () => ({ useMobileBackButton: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); capture.mockReset(); picker.pick.mockReset(); picker.native = true; });

it("uses the shared original-media picker on native mobile and keeps the attachment when cancelled", async () => {
  const file = new File(["original video"], "clip.mp4", { type: "video/mp4" });
  picker.pick.mockResolvedValueOnce(file).mockResolvedValueOnce(null);
  const onMedia = vi.fn();
  render(<MobileMediaPicker onMedia={onMedia} />);
  fireEvent.click(screen.getByRole("button", { name: "添加照片或视频" }));
  fireEvent.click(screen.getByRole("button", { name: "从相册选择" }));
  await waitFor(() => expect(onMedia).toHaveBeenCalledWith(file));
  expect(picker.pick).toHaveBeenCalledOnce();
  expect(capture).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "添加照片或视频" }));
  fireEvent.click(screen.getByRole("button", { name: "从相册选择" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onMedia).toHaveBeenCalledTimes(1);
});

it("opens the mixed-media browser file input without requesting camera capture", () => {
  picker.native = false;
  const onMedia = vi.fn();
  render(<MobileMediaPicker onMedia={onMedia} />);
  const input = screen.getByLabelText<HTMLInputElement>("附加照片或视频");
  const click = vi.spyOn(input, "click");
  expect(input.accept).toContain("video/mp4");
  expect(input.accept).toContain("video/quicktime");
  expect(input.accept).toContain("image/jpeg");
  expect(input.hasAttribute("capture")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "添加照片或视频" }));
  fireEvent.click(screen.getByRole("button", { name: "从相册选择" }));
  expect(click).toHaveBeenCalledOnce();
  expect(capture).not.toHaveBeenCalled();
  expect(picker.pick).not.toHaveBeenCalled();
  const file = new File(["original video"], "clip.mp4", { type: "video/mp4" });
  fireEvent.change(input, { target: { files: [file] } });
  expect(onMedia).toHaveBeenCalledWith(file);
  expect(input.value).toBe("");
  // Cancelling a later selection must not remove the current attachment.
  fireEvent.change(input, { target: { files: [] } });
  expect(onMedia).toHaveBeenCalledTimes(1);
});

it("keeps native photo capture and reports camera failures", async () => {
  const file = new File(["photo"], "camera.jpg", { type: "image/jpeg" });
  capture.mockResolvedValueOnce(file).mockRejectedValueOnce(new Error("相机权限未开启"));
  const onMedia = vi.fn();
  const onError = vi.fn();
  render(<MobileMediaPicker onMedia={onMedia} onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: "添加照片或视频" }));
  fireEvent.click(screen.getByRole("button", { name: "拍照" }));
  await waitFor(() => expect(onMedia).toHaveBeenCalledWith(file));
  fireEvent.click(screen.getByRole("button", { name: "添加照片或视频" }));
  fireEvent.click(screen.getByRole("button", { name: "拍照" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("相机权限未开启"));
});
