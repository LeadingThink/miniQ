import { useEffect } from "react";
import { App } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import { isIosIapAvailable, recoverIosTransactions, observeIosTransactions } from "../iosIap";
import { hasMobilePrivacyConsent } from "../mobilePrivacy";

/** Leave failures unfinished for a later login/manual retry; never grant credit locally. */
export function useIosIapRecovery(): void {
  useEffect(() => {
    if (!isIosIapAvailable()) return;
    let disposed = false;
    let running = false;
    let queued = false;
    const handles: PluginListenerHandle[] = [];
    const recover = async () => {
      if (disposed || !hasMobilePrivacyConsent()) return;
      if (running) { queued = true; return; }
      running = true;
      try { await recoverIosTransactions(); }
      catch { /* The account page exposes errors and an explicit retry action. */ }
      finally {
        running = false;
        if (queued && !disposed) { queued = false; void recover(); }
      }
    };
    const retain = async (promise: Promise<PluginListenerHandle>) => {
      try {
        const handle = await promise;
        if (disposed) await handle.remove(); else handles.push(handle);
      } catch { /* Startup and the account page still enumerate unfinished purchases. */ }
    };
    void retain(observeIosTransactions(() => { void recover(); }));
    void retain(App.addListener("appStateChange", ({ isActive }) => { if (isActive) void recover(); }));
    void recover();
    return () => { disposed = true; for (const handle of handles) void handle.remove().catch(() => {}); };
  }, []);
}
