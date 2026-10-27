// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageAttachmentPreview } from "./MessageAttachmentPreview";
import { readImagePreview } from "../localFiles";
vi.mock("../localFiles", () => ({ readImagePreview: vi.fn() }));
vi.mock("../sessionFileAccess", () => ({ useSessionFileAccess: () => undefined }));
afterEach(cleanup);

it("previews legacy image attachments without a MIME type", async () => {
  vi.mocked(readImagePreview).mockResolvedValue({ mimeType: "image/png", dataBase64: "aW1hZ2U=" } as never);
  render(<MessageAttachmentPreview attachment={{ path: "/work/legacy.png", name: "legacy.png" } as never} />);
  expect(await screen.findByRole("img", { name: "legacy.png" })).toBeTruthy();
});

it("uses a signed image URL and renews on error without creating a Blob", async () => {
  const refreshed = { getUrl: "https://bucket.qiniucs.com/remote-files/r/new", refresh: vi.fn().mockRejectedValue(new Error("exhausted")) };
  const source = { getUrl: "https://bucket.qiniucs.com/remote-files/r/old", refresh: vi.fn().mockResolvedValue(refreshed) };
  vi.mocked(readImagePreview).mockResolvedValue({ mimeType: "image/png", dataBase64: null, remoteSource: source as never });
  render(<MessageAttachmentPreview attachment={{ path: "/work/image.png", name: "image.png", mimeType: "image/png" } as never} />);
  const image = await screen.findByRole("img");
  expect(image.getAttribute("src")).toBe(source.getUrl);
  fireEvent.error(image);
  await waitFor(() => expect(image.getAttribute("src")).toBe(refreshed.getUrl));
  fireEvent.error(image);
  await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
  expect(source.refresh).toHaveBeenCalledOnce();
  expect(refreshed.refresh).toHaveBeenCalledOnce();
});
