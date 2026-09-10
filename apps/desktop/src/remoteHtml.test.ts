// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { prepareRemoteHtml } from "./remoteHtml";
import { readRemoteFile } from "./remoteFiles";
vi.mock("./remoteFiles", () => ({ readRemoteFile: vi.fn() }));

it("bundles relative images, CSS resources and scripts without giving the iframe RPC access", async () => {
  vi.mocked(readRemoteFile).mockImplementation(async (path) => {
    const content = path.endsWith(".css")
      ? 'body{background:url("../image.png")}'
      : path.endsWith(".js")
        ? 'document.title="interactive"'
        : "image bytes";
    return {
      path,
      kind: "text",
      mimeType: path.endsWith(".png") ? "image/png" : "text/plain",
      size: content.length,
      content: null,
      dataBase64: btoa(content),
    };
  });
  const html = await prepareRemoteHtml(
    '<link rel="stylesheet" href="css/style.css"><img src="image.png"><script src="app.js"></script>',
    "/work/index.html",
    { sessionId: "s1" },
  );
  expect(html).toContain('document.title="interactive"');
  expect(html).not.toContain('src="app.js"');
  expect(html).toContain("data:image/png;base64,");
  expect(html).not.toContain("isolated-preview");
  expect(
    vi
      .mocked(readRemoteFile)
      .mock.calls.every(([, options]) => options.sessionId === "s1"),
  ).toBe(true);
});
