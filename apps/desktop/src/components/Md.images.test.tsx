// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionFileAccess } from "../sessionFileAccess";
import { MarkdownLocalFilesContext } from "../markdownPolicy";
import type { RpcClient } from "../rpc";
import { Md } from "./Md";

const read = vi.hoisted(() => vi.fn());
vi.mock("../localFiles", async (original) => ({
  ...await original<typeof import("../localFiles")>(),
  readLocalFilePreview: read,
}));
beforeEach(() => {
  read.mockReset().mockResolvedValue({ kind: "image", mimeType: "image/png", dataBase64: "AA==", content: null });
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:chat-image");
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([false, true])("loads chat images using the session roots and authorized files (streaming=%s)", async (streaming) => {
  const client = { mode: "local" } as RpcClient;
  render(<SessionFileAccess client={client} sessionId="main" workspacePath="/work" workspacePaths={["/attached"]} authorizedFiles={["/output/chart.png"]}>
    <Md workspacePath="/work" streaming={streaming}>{"![图表](/output/chart.png)\n\n![相对图片](images/chart.png)"}</Md>
  </SessionFileAccess>);
  await waitFor(() => expect(screen.getByRole("img", { name: "图表" }).getAttribute("src")).toBe("blob:chat-image"));
  expect(read).toHaveBeenCalledWith("/output/chart.png", "/work", ["/attached"], expect.objectContaining({ client, sessionId: "main", signal: expect.any(AbortSignal), download: true }), ["/output/chart.png"]);
  expect(read).toHaveBeenCalledWith("/work/images/chart.png", "/work", ["/attached"], expect.anything(), ["/output/chart.png"]);
});

it("loads a Windows image from a chat with only a workspace path", async () => {
  render(<Md workspacePath="D:/work">{"![标记](D:/work/图.png)"}</Md>);
  await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).toBe("blob:chat-image"));
  expect(read).toHaveBeenCalledWith("D:/work/图.png", "D:/work", [], expect.anything(), []);
});

it("keeps external images on their original URL", () => {
  render(<Md workspacePath="/work">{"![网页图片](https://example.com/chart.png)"}</Md>);
  expect(screen.getByRole("img").getAttribute("src")).toBe("https://example.com/chart.png");
  expect(read).not.toHaveBeenCalled();
});

it.each([false, true])("keeps cloud images outside the local file scope (streaming=%s)", (streaming) => {
  const client = { mode: "local" } as RpcClient;
  render(<SessionFileAccess client={client} sessionId="main" workspacePath="/work" workspacePaths={["/attached"]} authorizedFiles={["/output/chart.png"]}>
    <MarkdownLocalFilesContext.Provider value={false}>
      <Md workspacePath="/work" streaming={streaming}>{"![本地图片](/output/chart.png)\n\n![相对图片](images/chart.png)\n\n![网页图片](https://example.com/chart.png)"}</Md>
    </MarkdownLocalFilesContext.Provider>
  </SessionFileAccess>);
  expect(screen.getByRole("img", { name: "网页图片" }).getAttribute("src")).toBe("https://example.com/chart.png");
  expect(screen.getByRole("img", { name: "本地图片" }).getAttribute("src")).toBeNull();
  expect(screen.getByRole("img", { name: "相对图片" }).getAttribute("src")).toBeNull();
  expect(read).not.toHaveBeenCalled();
});
