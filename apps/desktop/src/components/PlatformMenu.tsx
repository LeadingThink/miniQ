import { useId } from "react";
import { Check } from "lucide-react";
import { platforms, type AppPlatform } from "../platforms";
import "./PlatformMenu.css";

export function PlatformMenu({ platform, onSelect }: { platform: AppPlatform; onSelect: (next: AppPlatform) => void }) {
  const id = useId();
  return platforms.map((entry) => <button key={entry.id} type="button" role="menuitemradio" tabIndex={-1}
    aria-checked={platform === entry.id} aria-labelledby={`${id}-${entry.id}-name`}
    aria-describedby={`${id}-${entry.id}-description`} onClick={() => onSelect(entry.id)}>
    <span><strong id={`${id}-${entry.id}-name`}>{entry.name}</strong>
      <small id={`${id}-${entry.id}-description`}>{entry.description}</small></span>
    {platform === entry.id && <Check size={19} strokeWidth={1.6} aria-hidden="true" />}
  </button>);
}
