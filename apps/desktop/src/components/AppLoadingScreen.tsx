import type { ReactNode } from "react";
import { LoadingState } from "./ui/Spinner";
import "./AppLoadingScreen.css";

/** Shared fallback for switching between full application screens. */
export function AppLoadingScreen({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <main className="app-loading-screen">
      <div className="app-loading-content">
        <div className="app-loading-brand" aria-hidden="true">
          <span className="app-loading-mark">Q</span>
          <span className="app-loading-name">miniQ</span>
        </div>
        <LoadingState className="app-loading-status" label={label} />
        {children && <div className="app-loading-actions">{children}</div>}
      </div>
    </main>
  );
}
