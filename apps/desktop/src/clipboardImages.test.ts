// @vitest-environment jsdom
import { expect, it } from "vitest";
import { clipboardImages } from "./clipboardImages";

const item = (file: File) => ({ kind: "file", type: file.type, getAsFile: () => file }) as unknown as DataTransferItem;
const clipboard = (data: { items?: DataTransferItem[]; files?: File[] }) =>
  data as unknown as Pick<DataTransfer, "items" | "files">;

it("reads images exposed only through clipboard files", () => {
  const image = new File(["png"], "shot.png", { type: "image/png" });
  expect(clipboardImages(clipboard({ items: [], files: [image] }))).toEqual([image]);
});

it("infers the image type when the WebView leaves it empty", () => {
  const [image] = clipboardImages(clipboard({ items: [item(new File(["jpg"], "Photo.JPG"))] }));
  expect(image.name).toBe("Photo.JPG");
  expect(image.type).toBe("image/jpeg");
});

it("prefers supported formats when one copy offers several representations", () => {
  const tiff = new File(["tiff"], "copy.tiff", { type: "image/tiff" });
  const png = new File(["png"], "copy.png", { type: "image/png" });
  expect(clipboardImages(clipboard({ items: [item(tiff), item(png)], files: [png] }))).toEqual([png]);
  expect(clipboardImages(clipboard({ items: [item(tiff)] }))).toEqual([tiff]);
});

it("ignores text and non-image files", () => {
  const text = { kind: "string", type: "text/plain", getAsFile: () => null } as unknown as DataTransferItem;
  const pdf = new File(["pdf"], "report.pdf", { type: "application/pdf" });
  expect(clipboardImages(clipboard({ items: [text, item(pdf)] }))).toEqual([]);
});
