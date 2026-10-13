import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import { loadIosIapCatalog, observeIosStorefront, type IosIapCatalog } from "../iosIap";

/** Each storefront/foreground event invalidates the previous product request. */
export function useIosIapCatalog() {
  const [catalog, setCatalog] = useState<IosIapCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!mounted.current) return;
    const request = ++generation.current;
    setCatalog(null); setError(null); setLoading(true);
    try {
      const result = await loadIosIapCatalog();
      if (mounted.current && request === generation.current) setCatalog(result);
    } catch (cause) {
      if (mounted.current && request === generation.current) {
        setError(cause instanceof Error ? cause.message : "无法加载 Apple 商品，请重新加载购买项目。");
      }
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const handles: PluginListenerHandle[] = [];
    const retain = async (promise: Promise<PluginListenerHandle>) => {
      try {
        const handle = await promise;
        if (disposed) await handle.remove(); else handles.push(handle);
      } catch { /* Manual reload remains available if listener registration fails. */ }
    };
    const refresh = () => { if (!disposed) void reload(); };
    void retain(observeIosStorefront(refresh));
    void retain(App.addListener("appStateChange", ({ isActive }) => { if (isActive) refresh(); }));
    refresh();
    return () => {
      disposed = true; mounted.current = false; generation.current++;
      for (const handle of handles) void handle.remove().catch(() => {});
    };
  }, [reload]);
  return { catalog, loading, error, reload };
}
