import { createOneApiKey, loadOneApiKeys, type OneApiKey } from "./mobileIapAccount";
import { throwIfAborted } from "./abortSignal";

export function isUsableDesktopAccountKey(key: OneApiKey): boolean {
  return key.is_active && key.expire_time > Date.now() / 1000;
}

/** Read every page, including disabled and expired keys, without silently dropping entries. */
export async function loadDesktopAccountKeys(mainSiteSession?: string, signal?: AbortSignal): Promise<OneApiKey[]> {
  let page = 1;
  let count = 0;
  const keys: OneApiKey[] = [];
  while (true) {
    throwIfAborted(signal);
    const result = await loadOneApiKeys(page, mainSiteSession);
    throwIfAborted(signal);
    keys.push(...result.keys);
    count += result.keys.length;
    if (count >= result.total) break;
    if (result.keys.length === 0) throw new Error("Key 列表加载不完整，请重试。");
    page += 1;
  }
  return keys;
}

/** The settings login flow fills a usable key or creates one when none exists. */
export async function acquireDesktopAccountKey(mainSiteSession?: string, signal?: AbortSignal): Promise<string> {
  const keys = await loadDesktopAccountKeys(mainSiteSession, signal);
  throwIfAborted(signal);
  return keys.find(isUsableDesktopAccountKey)?.sk ?? (await createOneApiKey("miniQ 桌面端", mainSiteSession)).sk;
}
