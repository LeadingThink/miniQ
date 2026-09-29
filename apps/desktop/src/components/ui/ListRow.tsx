import type { ReactNode } from "react";

export interface ListRowProps {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Trailing accessory (badge, chevron, button…). Rendered outside the pressable area. */
  trailing?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  className?: string;
  /** Accessible name for the pressable area when the title is not plain text. */
  label?: string;
}

export function ListRow(props: ListRowProps) {
  const body = (
    <>
      {props.leading && <span className="ui-list-row-leading" aria-hidden="true">{props.leading}</span>}
      <span className="ui-list-row-text">
        <span className="ui-list-row-title">{props.title}</span>
        {props.subtitle && <span className="ui-list-row-subtitle">{props.subtitle}</span>}
      </span>
    </>
  );
  const className = [
    "ui-list-row",
    props.selected ? "selected" : "",
    props.onSelect ? "interactive" : "",
    props.disabled ? "disabled" : "",
    props.className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className} data-selected={props.selected ? "true" : undefined}>
      {props.onSelect ? (
        <button
          type="button"
          className="ui-list-row-main"
          aria-current={props.selected ? "true" : undefined}
          aria-label={props.label}
          disabled={props.disabled}
          onClick={props.onSelect}
        >
          {body}
        </button>
      ) : (
        <div className="ui-list-row-main">{body}</div>
      )}
      {props.trailing && <div className="ui-list-row-trailing">{props.trailing}</div>}
    </div>
  );
}
