// @vitest-environment jsdom
import { expect, it } from "vitest";
import { clipboardFiles } from "./clipboardFiles";

const item = (file: File) => ({ kind: "file", type: file.type, getAsFile: () => file }) as unknown as DataTransferItem;
const clipboard = (data: { items?: DataTransferItem[]; files?: File[] }) =>
  data as unknown as Pick<DataTransfer, "items" | "files">;

it("reads files exposed only through clipboard files", () => {
  const file = new File(["png"], "shot.png", { type: "image/png" });
  expect(clipboardFiles(clipboard({ items: [], files: [file] }))).toEqual([file]);
});

it("infers the image type when the WebView leaves it empty", () => {
  const [image] = clipboardFiles(clipboard({ items: [item(new File(["jpg"], "Photo.JPG"))] }));
  expect(image.name).toBe("Photo.JPG");
  expect(image.type).toBe("image/jpeg");
});

it("prefers supported formats when one copy offers several image representations", () => {
  const tiff = new File(["tiff"], "copy.tiff", { type: "image/tiff" });
  const png = new File(["png"], "copy.png", { type: "image/png" });
  expect(clipboardFiles(clipboard({ items: [item(tiff), item(png)], files: [png] }))).toEqual([png]);
  expect(clipboardFiles(clipboard({ items: [item(tiff)] }))).toEqual([tiff]);
});

it("keeps documents copied from the file manager", () => {
  const text = { kind: "string", type: "text/plain", getAsFile: () => null } as unknown as DataTransferItem;
  const pdf = new File(["pdf"], "报告.pdf", { type: "application/pdf" });
  expect(clipboardFiles(clipboard({ items: [text, item(pdf)] }))).toEqual([pdf]);
});

it("keeps a document beside an image and leaves plain text alone", () => {
  const pdf = new File(["pdf"], "report.pdf", { type: "application/pdf" });
  const png = new File(["png"], "shot.png", { type: "image/png" });
  expect(clipboardFiles(clipboard({ items: [item(pdf), item(png)] }))).toEqual([pdf, png]);
  expect(clipboardFiles(clipboard({ items: [item(new File(["注"], "note.txt", { type: "text/plain" }))] })))
    .toHaveLength(1);
  expect(clipboardFiles(clipboard({ items: [], files: [] }))).toEqual([]);
});
