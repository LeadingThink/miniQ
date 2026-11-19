import { invoke } from "@tauri-apps/api/core";
import { isUsableDesktopAccountKey, loadDesktopAccountKeys } from "./desktopAccountKey";
import { createOneApiKey, type OneApiKey } from "./mobileIapAccount";
import { throwIfAborted } from "./abortSignal";
import { isTauriRuntime } from "./runtime";
import { ZAIWEN_API_BASE_URL } from "./providerDefaults";
import type { RpcClient } from "./rpc";

export interface ZaiwenSessionStatus { supported: boolean; sessionId: string | null }
export interface ImportProvider {
  baseUrl: string;
  model: string;
  apiProtocol?: string;
  hasApiKey: boolean;
}

/** Returns an opaque session marker, never the main-site login token. */
export async function zaiwenSessionStatus(): Promise<ZaiwenSessionStatus> {
  if (!isTauriRuntime()) return { supported: false, sessionId: null };
  return invoke<ZaiwenSessionStatus>("zaiwen_session_status");
}

export function hasZaiwenKey(provider: ImportProvider | null): boolean {
  return !!provider?.hasApiKey && provider.baseUrl.replace(/\/+$/, "") === ZAIWEN_API_BASE_URL;
}

function assertLocalImport(client: RpcClient, signal: AbortSignal): void {
  if (!isTauriRuntime() || client.mode !== "local" || client.sshHost) {
    throw new Error("选择在问 API Key 仅支持桌面本机。");
  }
  throwIfAborted(signal);
}

/** Opening the picker lists the account's keys without creating or saving one. */
export async function loadZaiwenImportKeys(client: RpcClient, sessionId: string, signal: AbortSignal): Promise<OneApiKey[]> {
  assertLocalImport(client, signal);
  await invoke("zaiwen_account_login", { sessionId }).catch((cause: unknown) => {
    // The native SSO command emits fixed messages, without response bodies or credential URLs.
    throw new Error(typeof cause === "string" ? cause : "在问账户连接失败，请重试。");
  });
  throwIfAborted(signal);
  return loadDesktopAccountKeys(sessionId, signal);
}

/** Validates and returns the selected main-site key without changing miniQ settings. */
export async function selectZaiwenKey(
  client: RpcClient, sessionId: string, signal: AbortSignal, selectedKeyId: string | null,
): Promise<OneApiKey> {
  assertLocalImport(client, signal);
  const keys = await loadDesktopAccountKeys(sessionId, signal);
  const selected = keys.find((key) => key.key_id === selectedKeyId && isUsableDesktopAccountKey(key));
  if (selectedKeyId !== null && !selected) throw new Error("所选 API Key 已不可用，请取消后重新选择。");
  if (selectedKeyId === null && keys.some(isUsableDesktopAccountKey)) throw new Error("API Key 列表已变化，请取消后重新选择。");
  await validateSession(sessionId, signal);
  const key = selected ?? await createOneApiKey("miniQ 桌面端", sessionId);
  await validateSession(sessionId, signal);
  return key;
}

async function validateSession(sessionId: string, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const status = await zaiwenSessionStatus();
  throwIfAborted(signal);
  if (!status.supported || status.sessionId !== sessionId) throw new Error("在问账号已变化，请重新选择。");
}
