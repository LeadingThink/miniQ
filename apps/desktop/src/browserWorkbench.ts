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
  if (/[\r\n\t]/.test(candidate)) throw new Error("网址不能包含控制字符");
  const hostPort = /^(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):\d+(?:[/?#]|$)/i.test(candidate);
  const normalized = !hostPort && /^[a-z][a-z0-9+.-]*:/i.test(candidate) ? candidate : `https://${candidate}`;
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("内置浏览器只允许 HTTP(S) 页面");
  }
  if (url.username || url.password) throw new Error("网址不能包含账号或密码");
  return url.href;
}

export async function openBrowser(url: string, bounds: BrowserBounds, viewId: string): Promise<BrowserState> {
  const normalized = normalizeBrowserUrl(url);
  if (!isTauriRuntime()) return { url: normalized };
  return invokeBrowser<BrowserState>("browser_open", {
    url: normalized,
    bounds,
    viewId,
  });
}

export async function resizeBrowser(bounds: BrowserBounds, viewId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeBrowser("browser_resize", { bounds, viewId });
}

export async function browserAction(action: "back" | "forward" | "reload" | "stop", viewId: string) {
  if (!isTauriRuntime()) return null;
  return invokeBrowser<BrowserState>("browser_action", { action, viewId });
}

export async function currentBrowser(viewId: string): Promise<BrowserState | null> {
  if (!isTauriRuntime()) return null;
  return invokeBrowser<BrowserState>("browser_current", { viewId });
}

export async function closeBrowser(viewId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeBrowser("browser_close", { viewId });
}

export async function setBrowserVisible(viewId: string, visible: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeBrowser("browser_set_visible", { viewId, visible });
}
