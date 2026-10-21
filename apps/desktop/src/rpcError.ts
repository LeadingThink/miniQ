export interface RpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

/** Preserve structured daemon errors while keeping the existing display text. */
export class RpcResponseError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(readonly method: string, error: RpcErrorPayload) {
    super(`${error.message} (code ${error.code})`);
    this.name = "RpcResponseError";
    this.code = error.code;
    this.data = error.data;
  }
}
