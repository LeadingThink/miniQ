import { Sha256 } from "./incrementalSha256";
import { throwIfAborted } from "./abortSignal";
import type { RpcClient } from "./rpc";
export const MAX_REMOTE_FILE_BYTES = 200 * 1024 * 1024;
export const SMALL_RPC_FILE_BYTES = 256 * 1024;
const CHUNK_BYTES = 1024 * 1024;
export interface SignedDownload {
    transferId: string;
    getUrl: string;
    expiresAt: number;
    size: number;
    sha256: string;
    revision: string;
}
export interface SignedUpload {
    transferId: string;
    putUrl: string;
    expiresAt: number;
}
export function validateSignedStorageUrl(value: unknown): string {
    if (typeof value !== "string")
        throw new Error("远程对象地址无效");
    let url: URL;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error("远程对象地址无效");
    }
    if (url.protocol !== "https:" || url.username || url.password ||
        !url.hostname.endsWith(".qiniucs.com") || !/^\/(?:[^/]+\/)?remote-files\/[^/]+\//.test(url.pathname))
        throw new Error("远程对象地址无效");
    return url.toString();
}
export function validateDescriptor(value: SignedDownload): SignedDownload {
    const url = validateSignedStorageUrl(value.getUrl);
    if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_REMOTE_FILE_BYTES ||
        !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() ||
        !/^[a-f0-9]{64}$/i.test(value.sha256) || typeof value.revision !== "string")
        throw new Error("远程文件传输信息无效");
    return { ...value, getUrl: url };
}
async function readResponse(response: Response, expected: number, signal: AbortSignal | undefined, onProgress?: (received: number, total: number) => void, sha256?: string): Promise<Blob> {
    if (!response.ok || !response.body)
        throw new Error(`文件传输失败 (${response.status})`);
    const reader = response.body.getReader();
    const parts: BlobPart[] = [];
    const hash = new Sha256();
    const abort = () => { void reader.cancel().catch(() => { }); };
    signal?.addEventListener("abort", abort, { once: true });
    let received = 0;
    try {
        while (true) {
            throwIfAborted(signal);
            const item = await reader.read();
            if (item.done)
                break;
            received += item.value.byteLength;
            if (received > expected || received > MAX_REMOTE_FILE_BYTES)
                throw new Error("远程文件超出声明大小");
            hash.update(item.value);
            parts.push(new Blob([item.value]));
            onProgress?.(received, expected);
        }
    }
    finally {
        signal?.removeEventListener("abort", abort);
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    throwIfAborted(signal);
    if (sha256 && hash.hex() !== sha256)
        throw new Error("文件完整性校验失败");
    if (received !== expected)
        throw new Error("远程文件传输不完整");
    return new Blob(parts, { type: response.headers.get("content-type") ?? "application/octet-stream" });
}
export async function downloadRemoteFile(client: Pick<RpcClient, "call">, sessionId: string, path: string, revision: string, signal?: AbortSignal, onProgress?: (received: number, total: number) => void): Promise<SignedDownload & {
    blob: Blob;
}> {
    throwIfAborted(signal);
    for (let attempt = 0; attempt < 2; attempt++) {
        const ticket = await client.call<SignedDownload>("file.download.prepare", { sessionId, path, revision }, { signal, timeoutMs: 600000 });
        if (ticket.expiresAt <= Date.now() && attempt === 0)
            continue;
        const prepared = validateDescriptor(ticket);
        if (prepared.revision !== revision)
            throw new Error("文件版本已变化，请重新加载");
        try {
            const response = await fetch(prepared.getUrl, { signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store" });
            if ((response.status === 401 || response.status === 403) && attempt === 0) {
                await response.body?.cancel();
                continue;
            }
            const blob = await readResponse(response, prepared.size, signal, onProgress, prepared.sha256);
            return { ...prepared, blob };
        }
        catch (cause) {
            await client.call("file.transfer.cancel", { sessionId, transferId: prepared.transferId }).catch(() => { });
            throw cause;
        }
    }
    throw new Error("下载链接已过期，请重试");
}
export async function uploadRemoteFile(client: Pick<RpcClient, "call">, sessionId: string, file: File, signal?: AbortSignal, onProgress?: (sent: number, total: number) => void) {
    if (!Number.isSafeInteger(file.size) || file.size > MAX_REMOTE_FILE_BYTES)
        throw new Error("单个文件不能超过 200 MB");
    throwIfAborted(signal);
    const sha256 = await sha256File(file, signal);
    for (let attempt = 0; attempt < 2; attempt++) {
        throwIfAborted(signal);
        const prepared = await client.call<SignedUpload>("file.upload.prepare", { sessionId, name: file.name, size: file.size, sha256 }, { timeoutMs: 600000 });
        type Terminal = {
            status: string;
            path?: string;
            size?: number;
            sha256?: string;
        };
        let cancellation: Promise<Terminal> | undefined;
        const cancel = () => cancellation ??= client.call<Terminal>("file.transfer.cancel", { sessionId, transferId: prepared.transferId });
        let rejectAbort: (cause: unknown) => void = () => { };
        const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
        // The commit may be copying on the desktop when the user presses cancel.
        const onAbort = () => { void cancel().then(() => rejectAbort(new DOMException("Request cancelled", "AbortError")), rejectAbort); };
        signal?.addEventListener("abort", onAbort, { once: true });
        // Avoid an unhandled rejection while PUT is unwinding after an abort.
        void aborted.catch(() => { });
        try {
            throwIfAborted(signal);
            if (prepared.expiresAt <= Date.now())
                throw new Error("上传链接已过期 (403)");
            await putFile(validateSignedStorageUrl(prepared.putUrl), file, signal, onProgress);
            throwIfAborted(signal);
            const result = await Promise.race([client.call<{
                    status: "completed";
                    path: string;
                    size: number;
                    sha256: string;
                }>("file.upload.commit", { sessionId, transferId: prepared.transferId }, { timeoutMs: 600000 }), aborted]);
            if (result.status !== "completed" || result.size !== file.size || result.sha256 !== sha256 || !result.path)
                throw new Error("桌面收件回执校验失败");
            return result;
        }
        catch (cause) {
            const terminal = await cancel();
            if (terminal.status === "completed" && terminal.path && terminal.size === file.size && terminal.sha256 === sha256)
                return { status: "completed" as const, path: terminal.path, size: file.size, sha256 };
            if (!signal?.aborted && attempt === 0 && cause instanceof Error && /\((401|403)\)/.test(cause.message))
                continue;
            if (signal?.aborted && terminal.status !== "cancelled")
                throw new Error("桌面尚未确认取消，请检查项目收件箱");
            throw cause;
        }
        finally {
            signal?.removeEventListener("abort", onAbort);
        }
    }
    throw new Error("上传链接已过期，请重试");
}
function putFile(url: string, file: File, signal?: AbortSignal, onProgress?: (sent: number, total: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        const abort = () => request.abort();
        request.open("PUT", url);
        request.responseType = "text";
        request.setRequestHeader("Content-Type", "application/octet-stream");
        request.upload.onprogress = (event) => onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
        request.onerror = () => reject(new Error("上传失败"));
        request.onabort = () => reject(new DOMException("Request cancelled", "AbortError"));
        request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`上传失败 (${request.status})`));
        signal?.addEventListener("abort", abort, { once: true });
        request.onloadend = () => signal?.removeEventListener("abort", abort);
        if (signal?.aborted) {
            reject(new DOMException("Request cancelled", "AbortError"));
            return;
        }
        request.send(file);
    });
}
// WebCrypto digest requires one giant ArrayBuffer. This incremental SHA-256
// implementation keeps the upload bounded to one 1 MiB slice.
export async function sha256File(file: Blob, signal?: AbortSignal, onProgress?: (sent: number, total: number) => void) {
    const hash = new Sha256();
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
        throwIfAborted(signal);
        hash.update(new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer()));
        onProgress?.(Math.min(offset + CHUNK_BYTES, file.size), file.size);
    }
    return hash.hex();
}
