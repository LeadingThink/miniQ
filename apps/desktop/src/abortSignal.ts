/** AbortSignal.throwIfAborted and reason are unavailable in iOS 15.0–15.3. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Request cancelled", "AbortError");
  }
}
