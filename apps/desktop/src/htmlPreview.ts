export function isHtmlFile(path: string): boolean {
  return /\.html?$/i.test(path);
}

export function isolatedHtml(content: string, network: boolean): string {
  const document = new DOMParser().parseFromString(content, "text/html");
  const external = network ? " https: http:" : "";
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval'${external}`,
    `style-src 'unsafe-inline'${external}`,
    `img-src data: blob:${external}`,
    `font-src data:${external}`,
    `media-src data: blob:${external}`,
    `connect-src ${network ? "https: http:" : "'none'"}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  document.head.prepend(policy);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}
