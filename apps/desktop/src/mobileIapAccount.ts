import { Capacitor, CapacitorCookies, CapacitorHttp } from "@capacitor/core";
import { invoke } from "@tauri-apps/api/core";
import { MOBILE_API_BASE_URL } from "./mobileApiConfig";
import { isTauriRuntime } from "./runtime";

export type IapEnvironment = "Sandbox" | "Production";
export interface IapPurchaseContext {
  accountId: string;
  appAccountToken: string;
  environment: IapEnvironment;
}
export interface OneApiAccount { phone: string; nick: string; balance: number }
export interface OneApiKey {
  key_id: string;
  sk: string;
  remark: string;
  is_active: boolean;
  expire_time: number;
}
export interface OneApiKeysPage { total: number; keys: OneApiKey[] }

export const isAccountToken = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class IapApiError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

/** Native HTTP uses the OS cookie jar, including refreshed Set-Cookie responses.
 * Do not patch fetch globally: model streaming must continue to use web fetch.
 * Login JWTs are never copied into JS storage or used as model API Keys.
 */
export async function oneApiRequest(path: string, body?: unknown): Promise<unknown> {
  if (isTauriRuntime()) {
    const response = await invoke<{ status: number; data: unknown }>("desktop_account_request", {
      request: { baseUrl: MOBILE_API_BASE_URL, path, method: body === undefined ? "GET" : "POST", body: body ?? null },
    }).catch(() => { throw new Error("无法连接账户服务，请检查网络后重试。"); });
    return handleAccountResponse(response.status, response.data);
  }
  if (!Capacitor.isNativePlatform()) throw new Error("请在手机 App 中使用账户服务。");
  let response;
  try {
    response = await CapacitorHttp.request({
      url: `${MOBILE_API_BASE_URL}${path}`,
      method: body === undefined ? "GET" : "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-store" },
      ...(body === undefined ? {} : { data: body }),
      responseType: "json", connectTimeout: 30_000, readTimeout: 30_000, disableRedirects: true,
    });
  } catch { throw new Error("无法连接账户服务，请检查网络后重试。"); }
  return handleAccountResponse(response.status, response.data);
}

function handleAccountResponse(status: number, value: unknown): unknown {
  if (status === 401 || (isRecord(value) && value.code === "-2")) {
    throw new IapApiError("请重新登录账户。", "-2");
  }
  if (status === 429) throw new IapApiError("操作过于频繁，请稍后重试。", "429");
  if (status < 200 || status >= 300) {
    throw new IapApiError(`账户服务暂时不可用（${status}），请稍后重试。`, String(status));
  }
  // Existing OneAPI business failures may be returned with HTTP 200.
  if (!isRecord(value) || value.code !== "0") {
    throw new IapApiError("操作未完成，请检查验证码或账户状态后重试。", "request_failed");
  }
  return value.data;
}

export async function loadOneApiAccount(): Promise<OneApiAccount | null> {
  try {
    const value = await oneApiRequest("/user");
    if (!isRecord(value) || typeof value.phone !== "string" || typeof value.nick !== "string"
      || typeof value.balance !== "number" || !Number.isFinite(value.balance)) {
      throw new Error("账户信息格式无效，请稍后重试。");
    }
    return { phone: value.phone, nick: value.nick, balance: value.balance };
  } catch (error) {
    if (error instanceof IapApiError && error.code === "-2") return null;
    throw error;
  }
}

function validatePhone(phone: string): string {
  const value = phone.trim();
  if (!/^1[3-9]\d{9}$/.test(value)) throw new Error("请输入 11 位中国大陆手机号（不含 +86）。");
  return value;
}

export async function requestIapLoginCode(phone: string): Promise<void> {
  await oneApiRequest("/user/sms", { phone: validatePhone(phone) });
}

export async function loginIapAccount(phone: string, code: string): Promise<OneApiAccount> {
  if (!/^\d{6}$/.test(code.trim())) throw new Error("请输入 6 位短信验证码。");
  await oneApiRequest("/user/login", { phone: validatePhone(phone), code: code.trim(), inviteCode: "" });
  const account = await loadOneApiAccount();
  if (!account) throw new Error("登录状态未保存，请重新登录。");
  return account;
}

export async function logoutIapAccount(): Promise<void> {
  await oneApiRequest("/user/logout", {});
  if (Capacitor.isNativePlatform()) await CapacitorCookies.deleteCookie({ url: MOBILE_API_BASE_URL, key: "token" });
}

export async function deleteIapAccount(): Promise<void> {
  await oneApiRequest("/user/delete", {});
  if (Capacitor.isNativePlatform()) await CapacitorCookies.deleteCookie({ url: MOBILE_API_BASE_URL, key: "token" });
}

export async function loadIapPurchaseContext(): Promise<IapPurchaseContext> {
  const value = await oneApiRequest("/iap/apple/context");
  if (!isRecord(value) || typeof value.accountId !== "string" || !value.accountId
    || !isAccountToken(value.appAccountToken)
    || (value.environment !== "Sandbox" && value.environment !== "Production")) {
    throw new Error("购买账户信息无效，请稍后重试。");
  }
  return { accountId: value.accountId, appAccountToken: value.appAccountToken.toLowerCase(), environment: value.environment };
}

function parseKey(value: unknown): OneApiKey {
  if (!isRecord(value) || typeof value.key_id !== "string" || !value.key_id
    || typeof value.sk !== "string" || !value.sk || typeof value.remark !== "string"
    || typeof value.is_active !== "boolean" || typeof value.expire_time !== "number") {
    throw new Error("Key 信息格式无效，请重新加载。");
  }
  return { key_id: value.key_id, sk: value.sk, remark: value.remark,
    is_active: value.is_active, expire_time: value.expire_time };
}

export async function loadOneApiKeys(page: number): Promise<OneApiKeysPage> {
  const value = await oneApiRequest(`/keys?page=${page}&page_size=10`);
  if (!isRecord(value) || !Array.isArray(value.keys) || !Number.isSafeInteger(value.total) || (value.total as number) < 0) {
    throw new Error("Key 列表格式无效，请重新加载。");
  }
  return { total: value.total as number, keys: value.keys.map(parseKey) };
}

export async function createOneApiKey(remark: string): Promise<OneApiKey> {
  return parseKey(await oneApiRequest("/keys", {
    remark: remark.trim() || "miniQ", is_active: true, allow_model_ids: ["all"], quote_limit: 0,
  }));
}
