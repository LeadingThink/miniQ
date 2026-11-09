import { useId } from "react";
import { Switch, type SwitchProps } from "./ui/Switch";

type SettingsToggleProps = Pick<SwitchProps, "label" | "checked" | "onChange" | "disabled"> & {
  description: string;
};

export function SettingsToggle({ label, description, ...control }: SettingsToggleProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  return (
    <label className="settings-toggle" htmlFor={id}>
      <span>
        <strong>{label}</strong>
        <small id={descriptionId}>{description}</small>
      </span>
      <Switch {...control} id={id} label={label} describedBy={descriptionId} />
    </label>
  );
}
