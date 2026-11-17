const API_ORIGIN = "https://back.zaiwenai.com";

export interface ZaiwenResponse<T> {
  data?: T;
  token?: string;
  total?: number;
  next_cursor?: string | null;
}

export class ZaiwenApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ZaiwenApiError";
  }
  get requiresLogin(): boolean {
    return this.status === 401 || this.code === "02401" || this.code === "401";
  }
}

/** Shared authentication and origin for JSON requests and chat streams. */
export function fetchZaiwen(path: string, init: RequestInit = {}, token?: string | null): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("channel", "web.zaiwenai.com");
  headers.set("content-type", "application/json");
  if (token) headers.set("token", token);
  return fetch(`${API_ORIGIN}/api/v1/${path.replace(/^\/+/, "")}`, {
    ...init, headers, cache: "no-store",
  });
}

export async function readZaiwenResponse<T>(response: Response): Promise<ZaiwenResponse<T>> {
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ZaiwenApiError("在问服务返回的数据格式无效", response.status);
  }
  const value = payload as Record<string, unknown>;
  const code = value.code === undefined ? undefined : String(value.code);
  if (!response.ok || (code !== undefined && code !== "0")) {
    const message = typeof value.msg === "string" ? value.msg
      : typeof value.detail === "string" ? value.detail : `在问请求失败（${response.status}）`;
    throw new ZaiwenApiError(message, response.status, code);
  }
  return { ...value, token: response.headers.get("token") || value.token } as ZaiwenResponse<T>;
}

export async function requestZaiwen<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<ZaiwenResponse<T>> {
  return readZaiwenResponse<T>(await fetchZaiwen(path, init, token));
}
