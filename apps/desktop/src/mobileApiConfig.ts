import { DEV_MODEL_API_PREFIX, PRODUCTION_API_BASE_URL } from "./mobileApiEndpoints";

/** Account cookies, purchased credits and model Keys must use the same service. */
export const MOBILE_API_BASE_URL = (import.meta.env.VITE_MINIQ_API_BASE_URL || PRODUCTION_API_BASE_URL).replace(/\/+$/, "");
export const IS_MOBILE_TEST_API = MOBILE_API_BASE_URL !== PRODUCTION_API_BASE_URL;

/** The dev server forwards streaming requests without changing the Key's service identity. */
export const MOBILE_MODEL_API_BASE_URL = import.meta.env.DEV ? DEV_MODEL_API_PREFIX : MOBILE_API_BASE_URL;

/** TestFlight can replace the installed app; do not reuse its production Key. */
export function mobileCredentialStorageKey(key: string): string {
  return IS_MOBILE_TEST_API ? `${key}:${encodeURIComponent(MOBILE_API_BASE_URL)}` : key;
}
