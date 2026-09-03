import { isTauriRuntime } from "./runtime";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserState {
  url: string;
}

export function shouldSyncBrowserAddress(editing: boolean, current: string, previousUrl: string): boolean {
  return !editing && current === previousUrl;
}

async function invokeBrowser<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export function normalizeBrowserUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate) throw new Error("请输入网址");
  const normalized = /^[a-z][a-z0-9+.-]*:/i.test(candidate)
    ? candidate
    : `https://${candidate}`;
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("内置浏览器只允许 HTTP(S) 页面");
  }
  return url.href;
}

export async function openBrowser(url: string, bounds: BrowserBounds): Promise<BrowserState> {
  const normalized = normalizeBrowserUrl(url);
  if (!isTauriRuntime()) return { url: normalized };
  return invokeBrowser<BrowserState>("browser_open", { url: normalized, bounds });
}

export async function resizeBrowser(bounds: BrowserBounds): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeBrowser("browser_resize", { bounds });
}

export async function browserAction(action: "back" | "forward" | "reload" | "stop") {
  if (!isTauriRuntime()) return null;
  return invokeBrowser<BrowserState>("browser_action", { action });
}

export async function currentBrowser(): Promise<BrowserState | null> {
  if (!isTauriRuntime()) return null;
  return invokeBrowser<BrowserState>("browser_current");
}

export async function closeBrowser(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeBrowser("browser_close");
}
