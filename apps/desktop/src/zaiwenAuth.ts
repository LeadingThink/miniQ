import { requestZaiwen } from "./zaiwenApi";

const TOKEN_KEY = "miniq.zaiwen.token";
const USER_KEY = "miniq.zaiwen.user";

export interface ZaiwenUser {
  uid: string;
  nick?: string;
  phone?: string;
  avatar?: string;
}

export interface ZaiwenSession {
  token: string;
  user: ZaiwenUser;
}

function readJson<T>(key: string): T | null {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

function saveSession(session: ZaiwenSession | null): void {
  if (!session) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    return;
  }
  localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(USER_KEY, JSON.stringify(session.user));
}

export function getZaiwenToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function getZaiwenSession(): ZaiwenSession | null {
  const token = getZaiwenToken();
  const user = readJson<ZaiwenUser>(USER_KEY);
  return token && user?.uid ? { token, user } : null;
}

export function clearZaiwenSession(): void { saveSession(null); }

export async function requestZaiwenLoginCode(phone: string): Promise<void> {
  const normalized = phone.replace(/\s/g, "");
  if (!/^1[3-9]\d{9}$/.test(normalized)) throw new Error("请输入正确的 11 位手机号");
  await requestZaiwen("user/sms", { method: "POST", body: JSON.stringify({ phone: normalized }) }, getZaiwenToken());
}

export async function loginZaiwen(phone: string, code: string): Promise<ZaiwenSession> {
  const normalized = phone.replace(/\s/g, "");
  const normalizedCode = code.replace(/\s/g, "");
  if (!/^1[3-9]\d{9}$/.test(normalized)) throw new Error("请输入正确的 11 位手机号");
  if (!/^\d{4,6}$/.test(normalizedCode)) throw new Error("请输入短信验证码");
  const result = await requestZaiwen<ZaiwenUser>("user/login", {
    method: "POST",
    body: JSON.stringify({ phone: normalized, code: normalizedCode, inviteCode: "6836b4209ae477ab5fe32fd5" }),
  }, getZaiwenToken());
  const token = result.token;
  if (!token || !result.data?.uid) throw new Error("在问登录响应缺少有效会话");
  const session = { token, user: result.data };
  saveSession(session);
  return session;
}

export async function restoreZaiwenSession(): Promise<ZaiwenSession | null> {
  const token = getZaiwenToken();
  if (!token) return null;
  try {
    const result = await requestZaiwen<ZaiwenUser>("user/token", { method: "GET" }, token);
    if (!result.data?.uid) throw new Error("会话已失效");
    const session = { token, user: result.data };
    saveSession(session);
    return session;
  } catch {
    clearZaiwenSession();
    return null;
  }
}
