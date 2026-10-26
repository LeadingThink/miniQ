import { useSyncExternalStore } from "react";
import { isMobileLayout, MOBILE_LAYOUT_QUERY } from "../mobileViewport";

function subscribe(onChange: () => void) {
  const query = window.matchMedia?.(MOBILE_LAYOUT_QUERY);
  if (query) {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

export function useMobileLayout() {
  return useSyncExternalStore(subscribe, isMobileLayout, () => false);
}
