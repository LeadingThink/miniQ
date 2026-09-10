import { resolveWorkspacePath } from "./localFiles";
import { readRemoteFile, type FileReadOptions } from "./remoteFiles";
import { decodeBase64 } from "./previewBinary";

// Bundle local static resources into the isolated iframe. No filesystem paths,
// relay credentials or RPC bridge are exposed to scripts in the preview.
export async function prepareRemoteHtml(
  content: string,
  path: string,
  access: FileReadOptions,
): Promise<string> {
  const doc = new DOMParser().parseFromString(content, "text/html");
  const resources = new Map<string, Promise<{ text: string; url: string }>>();
  let totalBytes = new TextEncoder().encode(content).byteLength;
  const directory = (file: string) =>
    file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));
  function localPath(reference: string, base: string) {
    if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference))
      return null;
    return resolveWorkspacePath(reference.split(/[?#]/)[0], directory(base));
  }
  function read(reference: string, base: string) {
    const resolved = localPath(reference, base);
    if (!resolved) return null;
    let request = resources.get(resolved);
    if (!request) {
      request = readRemoteFile(resolved, { ...access, download: true }).then(
        (file) => {
          totalBytes += file.size;
          if (totalBytes > 64 * 1024 * 1024)
            throw new Error(
              "HTML 与本地资源总计超过 64 MB，请生成较小的预览版",
            );
          const data = file.dataBase64 ?? "";
          return {
            text: /^(text\/|image\/svg)/.test(file.mimeType)
              ? new TextDecoder().decode(decodeBase64(data))
              : "",
            url: `data:${file.mimeType};base64,${data}`,
          };
        },
      );
      resources.set(resolved, request);
    }
    return request;
  }
  async function css(source: string, base: string) {
    let output = source;
    const matches = [...source.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
    for (const match of matches) {
      const file = read(match[2], base);
      if (file) output = output.replace(match[0], `url("${(await file).url}")`);
    }
    return output;
  }
  for (const link of doc.querySelectorAll<HTMLLinkElement>(
    'link[rel="stylesheet"][href]',
  )) {
    const href = link.getAttribute("href")!;
    const file = read(href, path);
    if (!file) continue;
    const style = doc.createElement("style");
    style.textContent = await css((await file).text, localPath(href, path)!);
    link.replaceWith(style);
  }
  for (const style of doc.querySelectorAll("style"))
    style.textContent = await css(style.textContent ?? "", path);
  for (const element of doc.querySelectorAll<HTMLElement>("[style]"))
    element.setAttribute(
      "style",
      await css(element.getAttribute("style")!, path),
    );
  for (const element of doc.querySelectorAll(
    "img[src],video[src],audio[src],source[src],video[poster],script[src]",
  )) {
    for (const attribute of ["src", "poster"]) {
      const reference = element.getAttribute(attribute);
      const file = reference && read(reference, path);
      if (!file) continue;
      const resource = await file;
      if (element.tagName === "SCRIPT") {
        element.removeAttribute("src");
        element.textContent = resource.text;
      } else element.setAttribute(attribute, resource.url);
    }
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
