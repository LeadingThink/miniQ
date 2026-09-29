import type { CSSProperties } from "react";

export interface SpinnerProps {
  size?: number;
  /** Accessible label; when omitted the spinner is decorative. */
  label?: string;
  className?: string;
}

export function Spinner({ size = 16, label, className }: SpinnerProps) {
  const style = { "--ui-spinner-size": `${size}px` } as CSSProperties;
  return (
    <span
      className={`ui-spinner ${className ?? ""}`.trim()}
      style={style}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export interface LoadingStateProps {
  label: string;
  className?: string;
}

/** Centered spinner + label used for page/section loading fallbacks. */
export function LoadingState({ label, className }: LoadingStateProps) {
  return (
    <div className={`ui-loading-state ${className ?? ""}`.trim()} role="status" aria-live="polite">
      <Spinner size={16} />
      <span>{label}</span>
    </div>
  );
}
