import { createContext, useContext } from "react";
import { ChevronDown } from "lucide-react";
import type { AppPlatform } from "../platforms";

export const MobilePlatformContext = createContext<{
  platform: AppPlatform;
  menuOpen: boolean;
  openMenu: (anchor: HTMLElement) => void;
} | null>(null);

/** Uses the current page's title slot; ordinary browser pages keep their title. */
export function MobilePlatformTitle({ fallback = "miniQ", surface = "miniq", optional = false }: {
  fallback?: string; surface?: AppPlatform; optional?: boolean;
}) {
  const switcher = useContext(MobilePlatformContext);
  if (!switcher || switcher.platform !== surface) return optional ? null : <span>{fallback}</span>;
  return <button type="button" className="mobile-platform-title" aria-haspopup="menu" aria-expanded={switcher.menuOpen}
    onClick={(event) => switcher.openMenu(event.currentTarget)}>
    <span>{surface === "miniq" ? "miniQ" : "在问"}</span><ChevronDown size={15} aria-hidden="true" />
  </button>;
}
