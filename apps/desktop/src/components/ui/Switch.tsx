import type { KeyboardEvent } from "react";

export interface SwitchProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name; also used as the tooltip unless `title` is given. */
  label: string;
  title?: string;
  describedBy?: string;
  disabled?: boolean;
  className?: string;
}

/** Accessible toggle shared by settings and feature controls. */
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
      id={props.id}
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      aria-describedby={props.describedBy}
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
