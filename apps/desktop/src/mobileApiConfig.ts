const PRODUCTION_API_BASE_URL = "https://oneapi.zaiwenai.com/v1";

/** Account cookies, purchased credits and model Keys must use the same service. */
export const MOBILE_API_BASE_URL = (import.meta.env.VITE_MINIQ_API_BASE_URL || PRODUCTION_API_BASE_URL).replace(/\/+$/, "");
export const IS_MOBILE_TEST_API = MOBILE_API_BASE_URL !== PRODUCTION_API_BASE_URL;

/** TestFlight can replace the installed app; do not reuse its production Key. */
export function mobileCredentialStorageKey(key: string): string {
  return IS_MOBILE_TEST_API ? `${key}:${encodeURIComponent(MOBILE_API_BASE_URL)}` : key;
}
