import { useEffect, useRef, useState, type ReactNode } from "react";
import { goBackMobileZaiwen, listenMobilePlatformMenu } from "../mobileZaiwen";
import { MobilePageActivity } from "../mobilePageActivity";
import { useMobileZaiwenView } from "../hooks/useMobileZaiwenView";
import { useOpenDialog } from "../hooks/useOpenDialog";
import { useMobileBackButton } from "./MobileAppearanceSheet";
import type { AppPlatform } from "./PlatformSwitcher";
import { MobilePlatformContext, MobilePlatformTitle } from "./MobilePlatformTitle";
import { Menu } from "./ui/Menu";
import { PlatformMenu } from "./PlatformMenu";
import "./MobilePlatformShell.css";

/** The primary Capacitor page stays mounted and never navigates to remote code. */
export function MobilePlatformShell({ children }: { children: ReactNode }) {
  const [platform, setPlatform] = useState<AppPlatform>("miniq");
  const [menuOpen, setMenuOpen] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const siteAnchor = useRef<HTMLDivElement>(null);
  const modal = useOpenDialog();
  useEffect(() => { if (modal) setMenuOpen(false); }, [modal]);
  const siteActive = platform === "zaiwen";
  const selectPlatform = (next: AppPlatform) => {
    setMenuOpen(false);
    setPlatform(next);
  };
  const site = useMobileZaiwenView(surface, siteActive && !modal);
  useEffect(() => {
    if (!site.supported || !siteActive || modal) return;
    let disposed = false;
    const handle = listenMobilePlatformMenu((event) => {
      if (!disposed) {
        if (event?.platform === "miniq") { selectPlatform("miniq"); return; }
        anchor.current = siteAnchor.current; setMenuOpen(true);
      }
    });
    return () => { disposed = true; void handle.then((listener) => listener.remove()).catch(() => {}); };
  }, [site.supported, siteActive, modal]);
  const back = async () => {
    try { if (site.supported && (await goBackMobileZaiwen()).navigated) return; }
    catch { /* miniQ remains reachable even when the native view fails. */ }
    setPlatform("miniq");
  };
  useMobileBackButton(() => { if (menuOpen) setMenuOpen(false); else void back(); }, (siteActive || menuOpen) && !modal);
  return <MobilePlatformContext value={{ platform, menuOpen, openMenu: (element) => { anchor.current = element; setMenuOpen(true); } }}><div className="mobile-platform-shell" data-platform={platform}>
    <div className="mobile-platform-content" inert={siteActive} style={{ display: siteActive ? "none" : undefined }}>
      <MobilePageActivity value={!siteActive && !menuOpen}>{children}</MobilePageActivity>
    </div>
    <main className="mobile-platform-site" aria-label="在问主站" inert={!siteActive} style={{ display: siteActive ? undefined : "none" }}>
      <div ref={surface} className="mobile-platform-surface" aria-busy={site.loading}>
        <div ref={siteAnchor} className="mobile-platform-site-trigger" inert={modal}>
          {(menuOpen || site.loading || site.error || !site.supported) && <MobilePlatformTitle surface="zaiwen" fallback="在问" />}
        </div>
        {!site.supported ? <p role="alert">请使用包含在问切换功能的原生手机版。</p>
          : site.error ? <section role="alert"><p>{site.error}</p><button type="button" onClick={() => void site.retry()}>重试打开在问</button></section>
            : site.loading ? <p role="status">正在加载在问主站…</p> : null}
      </div>
    </main>
    <Menu open={menuOpen && !modal} anchorRef={anchor} onClose={() => setMenuOpen(false)} label="选择平台" className="platform-switcher-menu">
      <PlatformMenu platform={platform} onSelect={selectPlatform} />
    </Menu>
  </div></MobilePlatformContext>;
}
