import { useCallback, useEffect, useRef } from "react";
import type { Menu, MenuOptions } from "@tauri-apps/api/menu";

/** System menus paint above child WebViews without hiding or reloading the page. */
export function useNativeMenu(onError: (message: string) => void) {
  const menu = useRef<Menu | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void menu.current?.close().catch(onError);
      menu.current = null;
    };
  }, [onError]);

  return useCallback(async (options: MenuOptions, anchor: HTMLElement) => {
    if (pending.current) return;
    pending.current = true;
    const bounds = anchor.getBoundingClientRect();
    try {
      const { Menu } = await import("@tauri-apps/api/menu");
      const { LogicalPosition } = await import("@tauri-apps/api/dpi");
      const next = await Menu.new(options);
      if (!mounted.current) { await next.close(); return; }
      const previous = menu.current;
      menu.current = next;
      await previous?.close();
      // On Linux popup resolves before dismissal, so retain the resource until
      // the next open or unmount to keep its actions alive.
      await next.popup(new LogicalPosition(bounds.left, bounds.bottom));
    } catch (cause) {
      if (mounted.current) onError(`无法打开菜单：${String(cause)}`);
    } finally {
      pending.current = false;
    }
  }, [onError]);
}
