import { isTauriRuntime } from "./runtime";
import type { BrowserCapabilities } from "./types";
import type { BrowserLoadError } from "./browserEvents";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  url: string;
  loadError?: BrowserLoadError;
  /** Current zoom factor; returned by zoom actions. */
  zoom?: number;
}

export type BrowserNavigationAction = "back" | "forward" | "reload" | "stop";
export type BrowserCommandAction = "zoom_in" | "zoom_out" | "zoom_reset" | "print" | "devtools" | "clear_data";
export type BrowserActionName = BrowserNavigationAction | BrowserCommandAction;

export function shouldSyncBrowserAddress(editing: boolean, current: string, previousUrl: string): boolean {
  return !editing && current === previousUrl;
}

async function invokeBrowser<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export const BROWSER_SEARCH_URL = "https://www.bing.com/search?q=";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Loopback, private-network and mDNS hosts are usually plain-HTTP dev servers. */
export function isPrivateBrowserHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return true;
  if (name === "::1" || name === "0.0.0.0") return true;
  const ip = IPV4.exec(name);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function hostOf(candidate: string): string {
  const authority = candidate.split(/[/?#]/, 1)[0];
  if (authority.startsWith("[")) return authority.slice(0, authority.indexOf("]") + 1);
  return authority.replace(/:\d*$/, "");
}

function checkedWebUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("内置浏览器只允许 HTTP(S) 页面");
  }
  if (url.username || url.password) throw new Error("网址不能包含账号或密码");
  return url.href;
}

function withDefaultScheme(candidate: string): string {
  return `${isPrivateBrowserHost(hostOf(candidate)) ? "http" : "https"}://${candidate}`;
}

export function normalizeBrowserUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate) throw new Error("请输入网址");
  if (/[\r\n\t]/.test(candidate)) throw new Error("网址不能包含控制字符");
  const hostPort = /^(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):\d+(?:[/?#]|$)/i.test(candidate);
  const normalized = !hostPort && /^[a-z][a-z0-9+.-]*:/i.test(candidate) ? candidate : withDefaultScheme(candidate);
  return checkedWebUrl(normalized);
}

/** Schemes that are never a search query, even without "//". */
const EXPLICIT_SCHEME = /^(?:javascript|file|data|vbscript|about|blob|mailto|tel|sms|ftp|ws|wss|chrome|view-source|intent|content):/i;
const HOST_LIKE =
  /^(?:localhost|\[[a-f0-9:]+\]|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z][a-z0-9-]*[a-z0-9]|[a-z]|xn--[a-z0-9-]+)\.?|[a-z0-9.-]+(?=:\d))(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/**
 * Resolves address-bar input like a normal browser: URLs and host names open
 * directly, local/private hosts default to HTTP, anything else is a Bing
 * search. Non-web schemes and embedded credentials are rejected.
 */
export function resolveBrowserAddress(value: string): string {
  const candidate = value.trim();
  if (!candidate) throw new Error("请输入网址");
  if (/[\r\n\t]/.test(candidate)) throw new Error("网址不能包含控制字符");
  if (EXPLICIT_SCHEME.test(candidate)) return normalizeBrowserUrl(candidate.replace(/\s+/g, ""));
  if (!/\s/.test(candidate)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return normalizeBrowserUrl(candidate);
    const authority = candidate.split(/[/?#]/, 1)[0];
    if (authority.includes("@") && /^[^@]*:[^@]*@/.test(authority)) throw new Error("网址不能包含账号或密码");
    if (HOST_LIKE.test(candidate)) return normalizeBrowserUrl(candidate);
  }
  return `${BROWSER_SEARCH_URL}${encodeURIComponent(candidate)}`;
}

export async function openBrowser(
  url: string,
  bounds: BrowserBounds,
  viewId: string,
  visible = true,
): Promise<BrowserState> {
  const normalized = normalizeBrowserUrl(url);
  if (!isTauriRuntime()) return { url: normalized };
  return invokeBrowser<BrowserState>("browser_open", {
    url: normalized,
    bounds,
    viewId,
    visible,
  });
}

export async function resizeBrowser(bounds: BrowserBounds, viewId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeBrowser("browser_resize", { bounds, viewId });
}

export async function browserAction(action: BrowserActionName, viewId: string) {
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

export async function evaluateBrowser(viewId: string, script: string): Promise<string> {
  if (!isTauriRuntime()) throw new Error("此平台不支持内嵌浏览器 DOM 自动化");
  return invokeBrowser<string>("browser_evaluate", { viewId, script });
}

export async function screenshotBrowser(viewId: string): Promise<string> {
  if (!isTauriRuntime()) throw new Error("此平台不支持内嵌浏览器截图");
  return invokeBrowser<string>("browser_screenshot", { viewId });
}

/** Reveals a finished download in Finder / Explorer. */
export async function revealBrowserDownload(path: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeBrowser("browser_reveal_download", { path });
}

export async function browserCapabilities(): Promise<BrowserCapabilities> {
  if (!isTauriRuntime()) return {
    navigationControl: false,
    domSnapshot: false,
    screenshot: false,
    tabs: false,
    pointerInput: false,
    keyboardInput: false,
    selectInput: false,
  };
  return invokeBrowser<BrowserCapabilities>("browser_capabilities");
}
