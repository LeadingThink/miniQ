import { Check } from "lucide-react";
import { useId, useSyncExternalStore, type CSSProperties } from "react";
import {
  getAppearance,
  storeAppearanceMode,
  subscribeAppearance,
  themeById,
  THEMES,
  type AppearanceMode,
  type ThemeId,
  type ThemeMode,
} from "../theme";
import type { ThemeDefinition } from "../themeCatalog";
import { BackgroundPicker } from "./BackgroundPicker";

const MODES: { id: AppearanceMode; label: string }[] = [
  { id: "system", label: "自动" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
];

function previewStyle(theme: ThemeDefinition): CSSProperties {
  return Object.fromEntries(
    Object.entries(theme.preview).map(([key, value]) => [`--theme-${key}`, value])
  ) as CSSProperties;
}

function ThemePreview({ theme, split }: { theme: ThemeDefinition; split?: ThemeDefinition }) {
  return (
    <span className="theme-preview" aria-hidden="true">
      {[theme, split].map(
        (item, index) =>
          item && (
            <span key={index} className="theme-preview-half" style={previewStyle(item)}>
              <span className="theme-preview-sidebar">
                <i />
                <i />
                <i />
              </span>
              <span className="theme-preview-content">
                <i />
                <i />
                <b />
              </span>
            </span>
          )
      )}
    </span>
  );
}

function ThemeRow(props: {
  mode: ThemeMode;
  selected: ThemeId;
  active: boolean;
  onSelect: (theme: ThemeId) => void;
}) {
  const groupId = useId();
  const label = props.mode === "light" ? "浅色主题" : "深色主题";
  return (
    <section className="theme-row" aria-label={label}>
      <h3>
        {label}
        {props.active && <span>当前使用</span>}
      </h3>
      <div className="theme-grid" role="radiogroup" aria-label={label}>
        {THEMES.filter((theme) => theme.mode === props.mode).map((theme) => (
          <label key={theme.id} className="theme-choice" title={theme.description}>
            <input
              type="radio"
              name={`${groupId}-${props.mode}`}
              value={theme.id}
              checked={props.selected === theme.id}
              aria-label={theme.name}
              onChange={() => props.onSelect(theme.id)}
            />
            <ThemePreview theme={theme} />
            <span className="theme-copy">
              <span className="theme-swatch" style={{ background: theme.preview.accent }} aria-hidden="true" />
              <strong>{theme.name}</strong>
              {props.selected === theme.id && <Check className="theme-check" size={14} aria-hidden="true" />}
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

export function ThemePicker(props: { theme: ThemeId; onThemeChange: (theme: ThemeId) => void; showBackground?: boolean }) {
  const groupId = useId();
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const light = themeById(appearance.lastThemes.light);
  const dark = themeById(appearance.lastThemes.dark);
  const activeMode = themeById(props.theme).mode;
  return (
    <div className="appearance-settings">
      <section className="appearance-mode-row" aria-label="外观">
        <h3>外观</h3>
        <div className="appearance-modes" role="radiogroup" aria-label="明暗外观">
          {MODES.map((mode) => (
            <label key={mode.id} className="appearance-mode">
              <input
                type="radio"
                name={groupId}
                value={mode.id}
                checked={appearance.mode === mode.id}
                aria-label={mode.label}
                onChange={() => storeAppearanceMode(mode.id)}
              />
              <ThemePreview
                theme={mode.id === "dark" ? dark : light}
                split={mode.id === "system" ? dark : undefined}
              />
              <span>{mode.label}</span>
            </label>
          ))}
        </div>
        <p className="settings-section-description">
          {appearance.mode === "system" ? "随系统的浅色 / 深色外观自动切换。" : "始终使用所选外观。"}
        </p>
      </section>
      {(["light", "dark"] as const).map((mode) => (
        <ThemeRow
          key={mode}
          mode={mode}
          selected={appearance.lastThemes[mode]}
          active={activeMode === mode}
          onSelect={props.onThemeChange}
        />
      ))}
      {props.showBackground !== false && <BackgroundPicker />}
    </div>
  );
}
