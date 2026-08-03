import { isTauriRuntime } from "./runtime";

const SYSTEM_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export function parseExternalUrl(href: string, base?: string): URL | null {
  try {
    const resolvedBase =
      base ?? (typeof window === "undefined" ? "http://localhost/" : window.location.href);
    const url = new URL(href, resolvedBase);
    if (!SYSTEM_PROTOCOLS.has(url.protocol)) return null;
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.origin === new URL(resolvedBase).origin ? null : url;
    }
    return url;
  } catch {
    return null;
  }
}

export async function openExternalUrl(url: URL | string): Promise<void> {
  const href = typeof url === "string" ? url : url.href;
  if (isTauriRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}
