import type { CompanionMode } from "../../companionPrefs";
import type { CompanionState } from "./companionTask";

export interface CompanionAvatarProps {
  mode: CompanionMode;
  state: CompanionState;
  /** Rendered size in CSS pixels (pet: square; dots: pill height ≈ size × 0.42). */
  size?: number;
  className?: string;
}

/**
 * Original "sprout seed" character drawn inline (no external assets, not based on any
 * existing mascot). Colours come from theme variables in CompanionWindow.css so the
 * pet follows light / dark themes; motion is CSS-only and disabled for reduced motion.
 */
export function CompanionAvatar({ mode, state, size = 64, className }: CompanionAvatarProps) {
  if (mode === "dots") {
    return <span className={`companion-dots ${state} ${className ?? ""}`.trim()} style={{ height: Math.round(size * 0.42) }} aria-hidden="true">
      <i /><i /><i />
    </span>;
  }
  const happy = state === "ready";
  const sad = state === "failed";
  return <svg className={`companion-pet ${state} ${className ?? ""}`.trim()} width={size} height={size} viewBox="0 0 96 96" aria-hidden="true" focusable="false">
    <ellipse className="pet-shadow" cx="48" cy="88" rx="22" ry="3.5" />
    <g className="pet-figure">
      <g className="pet-sprout">
        <path className="pet-stem" d="M48 30C48 24 49 20 51 16" />
        <path className="pet-leaf" d="M51 17C53 9 61 6 68 8C66 16 59 20 51 17Z" />
        <path className="pet-leaf pet-leaf-small" d="M49 21C45 15 39 14 34 16C36 22 42 24 49 21Z" />
      </g>
      <path className="pet-body" d="M48 29C66 29 78 44 78 61C78 76 66 85 48 85C30 85 18 76 18 61C18 44 30 29 48 29Z" />
      <path className="pet-shine" d="M30 48C32 42 37 38 42 37" />
      <ellipse className="pet-cheek" cx="31" cy="66" rx="5" ry="3" />
      <ellipse className="pet-cheek" cx="65" cy="66" rx="5" ry="3" />
      {happy ? <g className="pet-eyes">
        <path className="pet-line" d="M33 59Q37 54 41 59" />
        <path className="pet-line" d="M55 59Q59 54 63 59" />
      </g> : sad ? <g className="pet-eyes">
        <path className="pet-line" d="M33 58L41 60" />
        <path className="pet-line" d="M63 58L55 60" />
      </g> : <g className="pet-eyes pet-blink">
        <ellipse className="pet-ink" cx="37" cy="58" rx="3" ry="3.6" />
        <ellipse className="pet-ink" cx="59" cy="58" rx="3" ry="3.6" />
      </g>}
      {sad ? <path className="pet-line" d="M43 71Q48 67 53 71" />
        : state === "needs_input" ? <ellipse className="pet-ink" cx="48" cy="70" rx="2.4" ry="2.8" />
        : <path className="pet-line" d={happy ? "M42 67Q48 74 54 67" : "M44 68Q48 71 52 68"} />}
    </g>
    {state === "running" && <g className="pet-orbit"><circle className="pet-orbit-dot" cx="48" cy="12" r="3.5" /></g>}
    {state === "needs_input" && <g className="pet-bubble">
      <rect x="68" y="6" width="22" height="22" rx="11" />
      <path d="M79 11.5V19.5" />
      <circle cx="79" cy="23.5" r="1.6" />
    </g>}
  </svg>;
}
