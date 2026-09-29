import type { KeyboardEvent } from "react";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name; also used as the tooltip unless `title` is given. */
  label: string;
  title?: string;
  disabled?: boolean;
  className?: string;
}

/** Accessible toggle. Keeps the legacy `.switch` classes so existing styling applies. */
export function Switch(props: SwitchProps) {
  const toggle = () => {
    if (!props.disabled) props.onChange(!props.checked);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "Enter") {
      // Handle explicitly so behaviour is identical across engines and the
      // native button activation does not toggle a second time.
      event.preventDefault();
      event.stopPropagation();
      toggle();
    }
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.title ?? props.label}
      disabled={props.disabled}
      className={`switch ui-switch ${props.checked ? "on" : ""} ${props.className ?? ""}`.trim()}
      onClick={(event) => {
        event.stopPropagation();
        toggle();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (event.key === " ") event.preventDefault();
      }}
    >
      <span className="switch-knob" aria-hidden="true" />
    </button>
  );
}
