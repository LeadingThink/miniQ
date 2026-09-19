// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { prepareRemoteHtml } from "./remoteHtml";
import { readRemoteFile } from "./remoteFiles";
vi.mock("./remoteFiles", () => ({ readRemoteFile: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const resource = (path: string, content: string, mimeType = "text/plain") => ({
  path,
  kind: "text" as const,
  mimeType,
  size: content.length,
  content: null,
  dataBase64: btoa(content),
});

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
  expect(html).toContain(`data:application/javascript;base64,${btoa('document.title="interactive"')}`);
  expect(html).not.toContain('src="app.js"');
  expect(html).toContain("data:image/png;base64,");
  expect(html).not.toContain("isolated-preview");
  expect(
    vi
      .mocked(readRemoteFile)
      .mock.calls.every(([, options]) => options.sessionId === "s1"),
  ).toBe(true);
});

it("bundles responsive images, imported styles, and script MIME types without duplicate transfers", async () => {
  const files: Record<string, string> = {
    "/work/style.css":
      '@import "styles/colors.css" screen; .hero{background:url("./image.png")}',
    "/work/styles/colors.css":
      'body{color:blue;background:url("../image.png")}',
    "/work/app.js": 'document.title="ready"',
  };
  vi.mocked(readRemoteFile).mockImplementation(async (path) =>
    resource(
      path,
      files[path] ?? "image",
      path.endsWith(".js") ? "application/javascript" : "text/plain",
    ),
  );
  const result = await prepareRemoteHtml(
    '<link rel="stylesheet" href="style.css" media="print"><img src="image.png" srcset="image.png 1x, large.png 2x, data:image/png;base64,aW1hZ2U= 3x"><script src="app.js"></script>',
    "/work/index.html",
    {},
  );
  const doc = new DOMParser().parseFromString(result, "text/html");
  expect(doc.querySelector("style")?.media).toBe("print");
  expect(doc.querySelector("style")?.textContent).toContain("@media screen");
  expect(doc.querySelector("style")?.textContent).toContain("color:blue");
  expect(doc.querySelector("script")?.getAttribute("src")).toBe(
    `data:application/javascript;base64,${btoa('document.title="ready"')}`,
  );
  expect(doc.querySelector("img")?.getAttribute("srcset")).not.toContain(
    "large.png",
  );
  expect(doc.querySelector("img")?.getAttribute("srcset")).toContain(
    "data:image/png;base64,aW1hZ2U= 3x",
  );
  expect(
    vi
      .mocked(readRemoteFile)
      .mock.calls.filter(([path]) => path === "/work/image.png"),
  ).toHaveLength(1);
});

it("bounds parallel requests and cancels queued resources when the preview closes", async () => {
  const started: string[] = [];
  const controller = new AbortController();
  vi.mocked(readRemoteFile).mockImplementation(
    (path, options) =>
      new Promise((_, reject) => {
        started.push(path);
        options.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        );
      }),
  );
  const pending = prepareRemoteHtml(
    Array.from({ length: 8 }, (_, i) => `<img src="${i}.png">`).join(""),
    "/work/index.html",
    { signal: controller.signal },
  );
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(started).toHaveLength(3);
  controller.abort();
  await rejected;
  expect(started).toHaveLength(3);
});

it("cancels sibling transfers on failure and rejects an over-budget resource before downloading it", async () => {
  let reserved = 0;
  const signals: AbortSignal[] = [];
  vi.mocked(readRemoteFile).mockImplementation(async (path, options) => {
    signals.push(options.signal!);
    options.reserveBytes?.(40 * 1024 * 1024);
    reserved++;
    return resource(path, "image");
  });
  await expect(
    prepareRemoteHtml(
      '<img src="a.png"><img src="b.png">',
      "/work/index.html",
      {},
    ),
  ).rejects.toThrow("64 MB");
  expect(reserved).toBe(1);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it("terminates cyclic CSS imports while retaining the original rules", async () => {
  vi.mocked(readRemoteFile).mockImplementation(async (path) =>
    resource(
      path,
      path.endsWith("a.css")
        ? '@import "b.css"; .a{color:red}'
        : '@import "a.css"; .b{color:blue}',
    ),
  );
  const result = await prepareRemoteHtml(
    '<link rel="stylesheet" href="a.css">',
    "/work/index.html",
    {},
  );
  expect(result).toContain(".a{color:red}");
  expect(result).toContain(".b{color:blue}");
  expect(readRemoteFile).toHaveBeenCalledTimes(2);
});

it("retains script loading semantics and literal closing tags inside script source", async () => {
  const source = 'document.querySelector("#result").textContent = "</script><p>not markup</p>";';
  vi.mocked(readRemoteFile).mockImplementation(async (path) => resource(path, source, "application/octet-stream"));
  const result = await prepareRemoteHtml(
    '<head><script defer src="app.js"></script><script async src="async.js"></script><script type="module" src="module.js"></script></head><body><div id="result"></div></body>',
    "/work/index.html", {},
  );
  const doc = new DOMParser().parseFromString(result, "text/html");
  const scripts = [...doc.querySelectorAll("script")];
  expect(scripts).toHaveLength(3);
  expect(scripts[0].hasAttribute("defer")).toBe(true);
  expect(scripts[1].hasAttribute("async")).toBe(true);
  expect(scripts[2].type).toBe("module");
  for (const script of scripts) {
    expect(script.getAttribute("src")).toBe(`data:application/javascript;base64,${btoa(source)}`);
    expect(script.textContent).toBe("");
  }
  expect(doc.querySelector("p")).toBeNull();
  expect(doc.querySelector("#result")).not.toBeNull();
});

it("preserves nested supports, named and anonymous layers, and media conditions on CSS imports", async () => {
  vi.mocked(readRemoteFile).mockImplementation(async (path) => resource(path, ".card{display:grid}"));
  const result = await prepareRemoteHtml(`<style>
    @import url("styles/a sheet.css") layer(theme) supports((display: grid) and (selector(:is(.a, .b)))) screen and (min-width: 600px);
    @import /* stylesheet */ "other.css" layer /* condition */ supports(display: grid);
    @import "quoted.css" supports(font-family: "semi;colon");
    </style>`, "/work/index.html", {});
  const css = new DOMParser().parseFromString(result, "text/html").querySelector("style")?.textContent;
  expect(css).toContain("@layer theme {@supports ((display: grid) and (selector(:is(.a, .b)))) {@media screen and (min-width: 600px) {.card{display:grid}}}}");
  expect(css).toContain("@layer {@supports (display: grid) {.card{display:grid}}}");
  expect(css).toContain('@supports (font-family: "semi;colon") {.card{display:grid}}');
  expect(readRemoteFile).toHaveBeenCalledWith("/work/styles/a sheet.css", expect.anything());
});

it("does not interpret CSS comments or quoted content as resource requests", async () => {
  vi.mocked(readRemoteFile).mockImplementation(async (path) => resource(path, "image", "image/png"));
  const result = await prepareRemoteHtml(`<style>
    /* @import "missing.css"; .ignored{background:url(missing.png)} */
    .sample:before{content:'url(missing-also.png)';background:url(real.png)}
    </style>`, "/work/index.html", {});
  expect(readRemoteFile).toHaveBeenCalledTimes(1);
  expect(readRemoteFile).toHaveBeenCalledWith("/work/real.png", expect.anything());
  expect(result).toContain("content:'url(missing-also.png)'");
  expect(result).toContain("@import \"missing.css\"");
});

it("resolves local resources against a declared document base", async () => {
  vi.mocked(readRemoteFile).mockImplementation(async (path) => resource(path, "image", "image/png"));
  await prepareRemoteHtml('<base href="assets/"><img src="cover%20image.png" srcset="cover%20image.png 1x, ../large.png 2x">', "/work/index.html", {});
  expect(vi.mocked(readRemoteFile).mock.calls.map(([path]) => path)).toEqual([
    "/work/assets/cover image.png", "/work/large.png",
  ]);
});

it("leaves resources under an external document base to the browser", async () => {
  const result = await prepareRemoteHtml('<base href="https://example.com/assets/"><link rel="stylesheet" href="styles.css"><img src="image.png"><style>@import "nested.css" layer(theme); .x{background:url(bg.png)}</style>', "/work/index.html", {});
  expect(readRemoteFile).not.toHaveBeenCalled();
  expect(result).toContain('src="https://example.com/assets/image.png"');
  expect(result).toContain('href="https://example.com/assets/styles.css"');
  expect(result).toContain('url("https://example.com/assets/bg.png")');
  expect(result).toContain('@import url("https://example.com/assets/nested.css") layer(theme);');
  expect(result).not.toContain("<base");
});
