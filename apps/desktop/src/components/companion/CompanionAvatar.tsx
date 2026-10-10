import type { CompanionMode } from "../../companionPrefs";
import type { CompanionState } from "./companionTask";

/** Original seed-shaped pet drawn here; no external assets or brand characters. */
export function CompanionAvatar({ mode, state }: { mode: CompanionMode; state: CompanionState }) {
  if (mode === "dots") return <span className={`companion-dots ${state}`} aria-hidden="true"><i /><i /><i /></span>;
  return <svg className={`companion-pet ${state}`} viewBox="0 0 96 96" aria-hidden="true">
    <ellipse className="pet-shadow" cx="48" cy="85" rx="25" ry="5" fill="currentColor" opacity=".12" />
    <g className="pet-body">
      <path d="M44 26C33 14 18 19 24 33C6 53 21 82 48 82C76 82 91 52 72 32C78 17 62 14 52 26Z" fill="var(--pet-fill)" stroke="var(--pet-stroke)" strokeWidth="2.5" />
      <path d="M48 26C43 18 45 9 57 8C58 17 54 23 48 26Z" fill="var(--pet-leaf)" stroke="var(--pet-stroke)" strokeWidth="2" />
      <ellipse className="pet-eye" cx="35" cy="49" rx="3" ry={state === "ready" ? 1.5 : 4} fill="var(--pet-stroke)" />
      <ellipse className="pet-eye" cx="61" cy="49" rx="3" ry={state === "ready" ? 1.5 : 4} fill="var(--pet-stroke)" />
      <ellipse cx="27" cy="58" rx="5" ry="3" fill="#eaa893" opacity=".65" />
      <ellipse cx="69" cy="58" rx="5" ry="3" fill="#eaa893" opacity=".65" />
      {state === "failed" ? <path d="M42 64Q48 58 54 64" fill="none" stroke="var(--pet-stroke)" strokeWidth="2" strokeLinecap="round" />
        : state === "needs_input" ? <circle cx="48" cy="61" r="3" fill="var(--pet-stroke)" />
        : <path d="M42 60Q48 67 54 60" fill="none" stroke="var(--pet-stroke)" strokeWidth="2" strokeLinecap="round" />}
    </g>
  </svg>;
}
