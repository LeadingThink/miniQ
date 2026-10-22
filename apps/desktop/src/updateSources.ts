/** Primary update feed, mirrored by `plugins.updater.endpoints[0]` in
 * apps/desktop/src-tauri/tauri.conf.json. updateSources.test.ts fails when the
 * two drift apart, so the reported source cannot go stale. */
export const UPDATE_PRIMARY_ENDPOINT =
  "https://oss.zaiwen.top/releases/miniq/latest.json";

export const UPDATE_PRIMARY_HOST = new URL(UPDATE_PRIMARY_ENDPOINT).host;

/** Wording tauri-plugin-updater uses when a feed cannot be reached or decoded. */
const SOURCE_FAILURE_MARKERS = [
  "error sending request",
  "error decoding response body",
  "for url (",
  "timed out",
  "failed to fetch",
  // Every feed answered, but none answered with a usable manifest.
  "could not fetch a valid release json",
];

/** True when a failed check failed while reading a feed.
 * The updater reports only the last feed it tried, and that is the GitHub
 * mirror whenever the primary feed produced nothing usable. */
export function isUpdateSourceFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return SOURCE_FAILURE_MARKERS.some((marker) => normalized.includes(marker));
}

/** Copy for a failed check. GitHub is a mirror, so its failure must never show
 * up as the reason; only the primary feed is worth reporting.
 * Failures that are not feed reads pass through unchanged. */
export function updateCheckFailureMessage(message: string): string {
  if (!isUpdateSourceFailure(message)) return message;
  return `无法连接更新主源 ${UPDATE_PRIMARY_HOST}，请检查网络后重试。`;
}
