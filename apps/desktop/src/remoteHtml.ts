import { resolveWorkspacePath } from "./localFiles";
import { throwIfAborted } from "./abortSignal";
import { readRemoteFile, type FileReadOptions } from "./remoteFiles";
import { decodeBase64 } from "./previewBinary";

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const PARALLEL_READS = 3;
const CSS_LITERALS = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;
type Resource = { data: string; url: string };
type ResourceReader = (
  reference: string,
  base: string,
) => Promise<Resource> | null;
const resourceText = (resource: Resource) =>
  new TextDecoder().decode(decodeBase64(resource.data));

function browserReference(reference: string, base: string): string {
  if (!/^https?:/i.test(base)) return reference;
  try { return new URL(reference, base).href; } catch { return reference; }
}

function localPath(reference: string, base: string): string | null {
  if (/^(?:https?:|\/\/)/i.test(base)) return null;
  if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference))
    return null;
  const directory = base.slice(
    0,
    Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")),
  );
  const resolved = resolveWorkspacePath(reference.split(/[?#]/)[0], directory);
  if (!resolved) return null;
  const separator = resolved.includes("\\") ? "\\" : "/";
  const segments: string[] = [];
  for (const part of resolved.split(/[\\/]/)) {
    if (part === ".") continue;
    if (part === ".." && segments.length > 1) segments.pop();
    else segments.push(part);
  }
  return segments.join(separator);
}

// Bundle static resources with a bounded number of encrypted transfers. The
// resulting iframe has no filesystem, relay credentials, or RPC bridge.
export async function prepareRemoteHtml(
  content: string,
  path: string,
  access: FileReadOptions,
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort(access.signal?.reason);
  if (access.signal?.aborted) abort();
  else access.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await bundleHtml(content, path, {
      ...access,
      signal: controller.signal,
    });
  } finally {
    controller.abort();
    access.signal?.removeEventListener("abort", abort);
  }
}

function createResourceReader(
  initialBytes: number,
  access: FileReadOptions,
): ResourceReader {
  const resources = new Map<string, Promise<Resource>>();
  const waiting: (() => void)[] = [];
  let active = 0;
  let totalBytes = initialBytes;
  const reserveBytes = (size: number) => {
    if (totalBytes + size > MAX_BUNDLE_BYTES)
      throw new Error("HTML 与本地资源总计超过 64 MB，请生成较小的预览版");
    totalBytes += size;
    access.reserveBytes?.(size);
  };
  reserveBytes(0);
  async function transfer(resolved: string): Promise<Resource> {
    if (active >= PARALLEL_READS)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      throwIfAborted(access.signal);
      const file = await readRemoteFile(resolved, {
        ...access,
        download: true,
        reserveBytes,
      });
      throwIfAborted(access.signal);
      const data = file.dataBase64 ?? "";
      return { data, url: `data:${file.mimeType};base64,${data}` };
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  return (reference, base) => {
    const resolved = localPath(reference, base);
    if (!resolved) return null;
    let request = resources.get(resolved);
    if (!request) {
      request = transfer(resolved);
      resources.set(resolved, request);
    }
    const fragment = reference.includes("#")
      ? reference.slice(reference.indexOf("#"))
      : "";
    return fragment
      ? request.then((resource) => ({
          ...resource,
          url: resource.url + fragment,
        }))
      : request;
  };
}

async function bundleCss(
  source: string,
  base: string,
  read: ResourceReader,
  ancestors = new Set([base]),
): Promise<string> {
  const imports = cssImports(source);
  const imported = await Promise.all(
    imports.map(async (match) => {
      const reference = match.reference;
      const resolved = localPath(reference, base);
      if (!resolved) return `@import url(${JSON.stringify(browserReference(reference, base))})${match.conditions ? ` ${match.conditions}` : ""};`;
      if (ancestors.has(resolved)) return "";
      const file = read(reference, base)!;
      const nested = await bundleCss(
        resourceText(await file),
        resolved,
        read,
        new Set([...ancestors, resolved]),
      );
      return wrapImportedCss(nested, match.conditions);
    }),
  );
  let output = replaceCssRanges(source, imports, imported);
  const code = maskCssLiterals(output);
  const urls = [...output.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)]
    .filter((match) => code.slice(match.index, match.index + 4).toLowerCase() === "url(");
  const values = await Promise.all(
    urls.map(async (match) => {
      const file = read(match[2], base);
      return file ? `url("${(await file).url}")` : `url(${JSON.stringify(browserReference(match[2], base))})`;
    }),
  );
  output = replaceCssRanges(output, urls.map((match) => ({ start: match.index, end: match.index + match[0].length })), values);
  return output;
}

// Preserve offsets while ignoring CSS comments and quoted declaration values.
function maskCssLiterals(source: string): string {
  return source.replace(CSS_LITERALS, (value) => " ".repeat(value.length));
}

function cssImports(source: string) {
  const code = maskCssLiterals(source);
  const clean = source.replace(CSS_LITERALS, (value) => value.startsWith("/*") ? " ".repeat(value.length) : value);
  const imports: { start: number; end: number; reference: string; conditions: string }[] = [];
  for (const token of code.matchAll(/@import\b/gi)) {
    const start = token.index;
    const prefix = /^@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)|"([^"]*)"|'([^']*)')\s*/i.exec(clean.slice(start));
    if (!prefix) continue;
    const conditionStart = start + prefix[0].length;
    let end = conditionStart;
    let depth = 0;
    for (; end < code.length; end++) {
      if (code[end] === "(") depth++;
      else if (code[end] === ")") depth--;
      else if (code[end] === ";" && depth === 0) break;
    }
    if (end === code.length) continue;
    imports.push({ start, end: end + 1, reference: prefix.slice(1).find((value) => value !== undefined)!,
      conditions: clean.slice(conditionStart, end).trim() });
  }
  return imports;
}

function wrapImportedCss(content: string, conditions: string): string {
  let remaining = conditions.trim();
  const wrappers: { rule: string; condition: string }[] = [];
  const takeFunction = (name: string) => {
    if (!remaining.toLowerCase().startsWith(`${name}(`)) return null;
    const code = maskCssLiterals(remaining);
    let depth = 1;
    for (let index = name.length + 1; index < code.length; index++) {
      if (code[index] === "(") depth++;
      else if (code[index] === ")" && --depth === 0) {
        const argument = remaining.slice(name.length + 1, index).trim();
        remaining = remaining.slice(index + 1).trim();
        return argument;
      }
    }
    return null;
  };
  const layer = takeFunction("layer");
  if (layer !== null) wrappers.push({ rule: "layer", condition: layer });
  else if (/^layer(?:\s|$)/i.test(remaining)) {
    wrappers.push({ rule: "layer", condition: "" });
    remaining = remaining.slice(5).trim();
  }
  const supports = takeFunction("supports");
  if (supports !== null) wrappers.push({ rule: "supports", condition: `(${supports})` });
  if (remaining) wrappers.push({ rule: "media", condition: remaining });
  return wrappers.reverse().reduce((nested, wrapper) => `@${wrapper.rule}${wrapper.condition ? ` ${wrapper.condition}` : ""} {${nested}}`, content);
}

function replaceCssRanges(source: string, matches: { start: number; end: number }[], values: string[]): string {
  let output = "";
  let offset = 0;
  matches.forEach((match, index) => {
    output += source.slice(offset, match.start) + values[index];
    offset = match.end;
  });
  return output + source.slice(offset);
}

async function bundleHtml(
  content: string,
  path: string,
  access: FileReadOptions,
) {
  throwIfAborted(access.signal);
  const doc = new DOMParser().parseFromString(content, "text/html");
  const declaredBase = doc.querySelector("base[href]")?.getAttribute("href")?.trim();
  if (declaredBase) {
    // Relative references follow the document's first base element. External
    // bases belong to the browser and must not trigger desktop file reads.
    path = /^(?:https?:|\/\/)/i.test(declaredBase)
      ? new URL(declaredBase, window.location.href).href : localPath(declaredBase, path) ?? path;
    for (const element of doc.querySelectorAll("a[href],area[href],form[action]")) {
      for (const attribute of ["href", "action"]) {
        const reference = element.getAttribute(attribute);
        if (reference) element.setAttribute(attribute, browserReference(reference, path));
      }
    }
    // isolatedHtml intentionally blocks base-uri. Resolve dependencies here
    // and remove the declaration instead of broadening the iframe policy.
    doc.querySelectorAll("base").forEach((element) => element.remove());
  }
  const read = createResourceReader(
    new TextEncoder().encode(content).byteLength,
    access,
  );
  const links = [
    ...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'),
  ];
  const styles = [...doc.querySelectorAll("style")];
  const inlineStyles = [...doc.querySelectorAll<HTMLElement>("[style]")];
  const media = [
    ...doc.querySelectorAll(
      "img[src],video[src],audio[src],source[src],video[poster],script[src]",
    ),
  ];
  const responsiveImages = [
    ...doc.querySelectorAll("img[srcset],source[srcset]"),
  ];
  await Promise.all([
    ...links.map(async (link) => {
      const href = link.getAttribute("href")!;
      const file = read(href, path);
      if (!file) { link.setAttribute("href", browserReference(href, path)); return; }
      const style = doc.createElement("style");
      style.textContent = await bundleCss(
        resourceText(await file),
        localPath(href, path)!,
        read,
      );
      if (link.media) style.media = link.media;
      link.replaceWith(style);
    }),
    ...styles.map(async (style) => {
      style.textContent = await bundleCss(style.textContent ?? "", path, read);
    }),
    ...inlineStyles.map(async (element) => {
      element.setAttribute(
        "style",
        await bundleCss(element.getAttribute("style")!, path, read),
      );
    }),
    ...media.map(async (element) => {
      await Promise.all(
        ["src", "poster"].map(async (attribute) => {
          const reference = element.getAttribute(attribute);
          const file = reference && read(reference, path);
          if (!file) {
            if (reference) element.setAttribute(attribute, browserReference(reference, path));
            return;
          }
          const resource = await file;
          if (element.tagName === "SCRIPT") {
            // Keeping src preserves defer/async/module execution semantics and
            // avoids reparsing literal </script> strings as HTML markup.
            element.setAttribute("src", `data:application/javascript;base64,${resource.data}`);
          } else element.setAttribute(attribute, resource.url);
        }),
      );
    }),
    ...responsiveImages.map(async (element) => {
      const candidates = parseSrcset(element.getAttribute("srcset")!);
      const values = await Promise.all(
        candidates.map(async ({ url, descriptor }) => {
          const file = read(url, path);
          return `${file ? (await file).url : browserReference(url, path)}${descriptor ? ` ${descriptor}` : ""}`;
        }),
      );
      element.setAttribute("srcset", values.join(", "));
    }),
  ]);
  throwIfAborted(access.signal);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

// A URL token may itself contain commas (notably data URLs), so splitting on
// commas would corrupt existing inline images. Descriptors end at a comma.
function parseSrcset(source: string): { url: string; descriptor: string }[] {
  const candidates: { url: string; descriptor: string }[] = [];
  let offset = 0;
  while (offset < source.length) {
    while (/[\s,]/.test(source[offset] ?? "") && offset < source.length)
      offset++;
    const start = offset;
    while (offset < source.length && !/\s/.test(source[offset])) offset++;
    let url = source.slice(start, offset);
    if (!url) break;
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
      candidates.push({ url, descriptor: "" });
      continue;
    }
    const descriptorStart = offset;
    while (offset < source.length && source[offset] !== ",") offset++;
    candidates.push({
      url,
      descriptor: source.slice(descriptorStart, offset).trim(),
    });
    offset++;
  }
  return candidates;
}
