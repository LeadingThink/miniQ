// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownImage } from "./MarkdownImage";
import { MarkdownPreview } from "./MarkdownPreview";
const read = vi.hoisted(() => vi.fn());
vi.mock("../localFiles", async (original) => ({
  ...(await original<typeof import("../localFiles")>()),
  readLocalFilePreview: read,
}));
beforeEach(() => {
  read.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);
const props = {
  workspacePath: "/work",
  workspacePaths: ["/attached"],
  referenceBasePath: "/work/docs",
  alt: "样例",
};
it("resolves relative assets through the workspace-scoped reader and revokes URLs", async () => {
  read.mockResolvedValue({
    kind: "image",
    mimeType: "image/png",
    dataBase64: "AA==",
    content: null,
  });
  const view = render(<MarkdownImage {...props} src="images/%E5%9B%BE.png" />);
  await screen.findByRole("img");
  expect(read).toHaveBeenCalledWith("/work/docs/images/图.png", "/work", [
    "/attached",
  ]);
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
});
it("does not publish a late image after unmount", async () => {
  let finish!: (value: unknown) => void;
  read.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(<MarkdownImage {...props} src="image.png" />);
  await waitFor(() => expect(read).toHaveBeenCalled());
  view.unmount();
  await act(async () =>
    finish({
      kind: "image",
      mimeType: "image/png",
      dataBase64: "AA==",
      content: null,
    }),
  );
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("does not reread images when the Markdown outline rerenders", async () => {
  read.mockResolvedValue({
    kind: "image",
    mimeType: "image/png",
    dataBase64: "AA==",
    content: null,
  });
  const content = "# Report\n\n![样例](image.png)";
  const element = () => (
    <MarkdownPreview
      content={content}
      workspacePath="/work"
      workspacePaths={["/attached"]}
      currentFilePath="/work/docs/report.md"
      onOpenFile={() => {}}
    />
  );
  const view = render(element());
  await screen.findByRole("img");
  view.rerender(element());
  expect(read).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
});
it("rejects executable schemes and surfaces workspace denials", async () => {
  const view = render(<MarkdownImage {...props} src="javascript:alert(1)" />);
  await screen.findByText(/图片路径无效/);
  expect(read).not.toHaveBeenCalled();
  read.mockRejectedValue(new Error("拒绝打开工作区外的文件"));
  view.rerender(<MarkdownImage {...props} src="../../outside.png" />);
  await screen.findByText(/拒绝打开工作区外/);
});
