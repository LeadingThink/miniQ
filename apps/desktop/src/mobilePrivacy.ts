export const MINIQ_PRIVACY_URL = "https://chat.zaiwenai.com/miniq/privacy";
export const MINIQ_SUPPORT_URL = "https://chat.zaiwenai.com/miniq/support";

const CONSENT_KEY = "miniq.mobile.privacyConsent.v1";
const CURRENT_CONSENT = "2026-09-16";

export function hasMobilePrivacyConsent(storage: Storage = window.localStorage): boolean {
  try {
    return storage.getItem(CONSENT_KEY) === CURRENT_CONSENT;
  } catch {
    return false;
  }
}

export function recordMobilePrivacyConsent(storage: Storage = window.localStorage): void {
  storage.setItem(CONSENT_KEY, CURRENT_CONSENT);
}

export function clearMobilePrivacyConsent(storage: Storage = window.localStorage): void {
  storage.removeItem(CONSENT_KEY);
}
