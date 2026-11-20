import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { mobileZaiwenCapabilities, readMobileZaiwenState, reloadMobileZaiwen,
  updateMobileZaiwen, type MobileZaiwenState } from "../mobileZaiwen";

const FAILURE = "无法打开在问主站，请重试。";

export function useMobileZaiwenView(surface: RefObject<HTMLElement | null>, active: boolean) {
  const supported = mobileZaiwenCapabilities().embeddedView;
  const [state, setState] = useState<MobileZaiwenState>({ loading: true, canGoBack: false, error: null });
  const retryAction = useRef(async () => {});
  useEffect(() => {
    if (!supported) return;
    if (!active) { void updateMobileZaiwen({ visible: false }).catch(() => {}); return; }
    let disposed = false;
    let commandFailed = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = () => {
      if (disposed) return;
      commandFailed = true;
      setState({ loading: false, canGoBack: false, error: FAILURE });
      void updateMobileZaiwen({ visible: false }).catch(() => {});
    };
    const layout = async () => {
      if (disposed) return false;
      const rect = surface.current?.getBoundingClientRect();
      const visible = !document.hidden && rect && rect.width > 0 && rect.height > 0;
      if (disposed) return false;
      try {
        const next = await updateMobileZaiwen(visible ? { visible: true, x: rect.left, y: rect.top,
          width: rect.width, height: rect.height, viewportWidth: window.innerWidth } : { visible: false });
        if (disposed) return false;
        commandFailed = false;
        setState(next);
        return Boolean(visible);
      } catch { fail(); return false; }
    };
    const poll = async () => {
      try {
        if (!commandFailed) {
          const next = await readMobileZaiwenState();
          if (!disposed && !commandFailed) setState(next);
        }
      }
      catch { fail(); }
      if (!disposed) timer = setTimeout(() => void poll(), 750);
    };
    retryAction.current = async () => {
      if (disposed) return;
      setState({ loading: true, canGoBack: false, error: null });
      // Recreate/reposition a missing native view before asking it to reload.
      if (!await layout()) return;
      try {
        const next = await reloadMobileZaiwen();
        if (!disposed) setState(next);
      } catch { fail(); }
    };
    const resize = () => { void layout(); };
    const observer = new ResizeObserver(resize);
    if (surface.current) observer.observe(surface.current);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    document.addEventListener("visibilitychange", resize);
    void layout(); void poll();
    return () => {
      disposed = true; clearTimeout(timer); observer.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
      document.removeEventListener("visibilitychange", resize);
      void updateMobileZaiwen({ visible: false }).catch(() => {});
    };
  }, [active, supported, surface]);
  const retry = useCallback(() => retryAction.current(), []);
  return { ...state, supported, retry };
}
