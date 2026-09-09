// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BlobPreview } from "./MediaPreview";

beforeEach(() => {
  let sequence = 0;
  URL.createObjectURL = vi.fn(() => `blob:media-${++sequence}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

it("does not recreate media when the parent's error callback changes", () => {
  const view = render(
    <BlobPreview
      dataBase64="AA=="
      mimeType="image/png"
      kind="image"
      label="one"
      onError={() => {}}
    />,
  );
  const image = screen.getByRole("img");
  const onError = vi.fn();
  view.rerender(
    <BlobPreview
      dataBase64="AA=="
      mimeType="image/png"
      kind="image"
      label="one"
      onError={onError}
    />,
  );
  expect(screen.getByRole("img")).toBe(image);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  fireEvent.error(image);
  expect(onError).toHaveBeenCalledWith("图片解码失败");
});

it("fits images, displays real dimensions and supports native size and zoom", () => {
  render(
    <BlobPreview
      dataBase64="AA=="
      mimeType="image/png"
      kind="image"
      label="chart"
      onError={vi.fn()}
    />,
  );
  const image = screen.getByRole("img");
  Object.defineProperties(image, {
    naturalWidth: { value: 1200 },
    naturalHeight: { value: 800 },
  });
  fireEvent.load(image);
  expect(screen.getByText("1200 × 800 px")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "图片原始尺寸" }));
  expect((image as HTMLImageElement).style.width).toBe("1200px");
  fireEvent.change(screen.getByRole("slider"), { target: { value: 200 } });
  expect((image as HTMLImageElement).style.width).toBe("2400px");
  fireEvent.click(screen.getByRole("button", { name: "适配图片" }));
  expect((image as HTMLImageElement).style.width).toBe("");
});

it("releases replaced sources, resets image state and really retries decoding on remount", () => {
  const onError = vi.fn();
  const view = render(
    <BlobPreview
      key={0}
      dataBase64="AA=="
      mimeType="image/png"
      kind="image"
      label="one"
      onError={onError}
    />,
  );
  const first = screen.getByRole("img");
  fireEvent.error(first);
  expect(onError).toHaveBeenCalledWith("图片解码失败");
  view.rerender(
    <BlobPreview
      key={1}
      dataBase64="AA=="
      mimeType="image/png"
      kind="image"
      label="one"
      onError={onError}
    />,
  );
  expect(screen.getByRole("img")).not.toBe(first);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:media-1");
  view.rerender(
    <BlobPreview
      key={1}
      dataBase64="AQ=="
      mimeType="image/png"
      kind="image"
      label="two"
      onError={onError}
    />,
  );
  expect(screen.getByRole("img").getAttribute("src")).toBe("blob:media-3");
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
});

it("reports malformed base64 without crashing the preview tree", () => {
  const onError = vi.fn();
  render(
    <BlobPreview
      dataBase64="invalid!"
      mimeType="image/png"
      kind="image"
      label="bad"
      onError={onError}
    />,
  );
  expect(onError).toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("uses an inline, metadata-only video player and reports decode errors", () => {
  const onError = vi.fn();
  render(
    <BlobPreview
      dataBase64="AA=="
      mimeType="video/mp4"
      kind="video"
      label="clip"
      onError={onError}
    />,
  );
  const video = screen.getByLabelText("clip") as HTMLVideoElement;
  expect(video.preload).toBe("metadata");
  expect(video.playsInline).toBe(true);
  expect(video.autoplay).toBe(false);
  fireEvent.error(video);
  expect(onError).toHaveBeenCalledWith("视频解码失败");
});
