import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Compact variant for sidebars and inline lists. */
  compact?: boolean;
  className?: string;
  /** Announce to assistive tech when it appears as a result of user input (e.g. search). */
  live?: boolean;
  children?: ReactNode;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div
      className={`ui-empty-state ${props.compact ? "compact" : ""} ${props.className ?? ""}`.trim()}
      role={props.live ? "status" : undefined}
    >
      {props.icon && <div className="ui-empty-state-icon" aria-hidden="true">{props.icon}</div>}
      <div className="ui-empty-state-title">{props.title}</div>
      {props.description && <div className="ui-empty-state-description">{props.description}</div>}
      {props.action && <div className="ui-empty-state-action">{props.action}</div>}
      {props.children}
    </div>
  );
}
