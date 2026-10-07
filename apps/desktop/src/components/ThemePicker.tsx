import { Check } from "lucide-react";
import { useId, useState, useSyncExternalStore, type CSSProperties } from "react";
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
import { themeCategories, type ThemeDefinition } from "../themeCatalog";
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
  query: string;
  category: string;
}) {
  const groupId = useId();
  const [page, setPage] = useState(0);
  const matches = THEMES.filter((theme) => theme.mode === props.mode
    && (props.category === "all" || theme.category === props.category)
    && [theme.id, theme.name, theme.description].join(" ").toLowerCase().includes(props.query.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(matches.length / 12));
  const current = Math.min(page, pages - 1);
  const selectedIndex = matches.findIndex((theme) => theme.id === props.selected);
  const label = props.mode === "light" ? "浅色主题" : "深色主题";
  return (
    <section className="theme-row" aria-label={label}>
      <h3>
        {label} · {matches.length}
        {props.active && <span>当前使用</span>}
      </h3>
      <div className="theme-grid" role="radiogroup" aria-label={label}>
        {matches.slice(current * 12, (current + 1) * 12).map((theme) => (
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
      {!matches.length && <p className="settings-section-description">没有匹配的配色主题，请调整搜索或分类。</p>}
      <div className="theme-pagination" aria-label={`${label}分页`}>
        <span>已选：{themeById(props.selected).name}</span>
        {selectedIndex >= 0 && Math.floor(selectedIndex / 12) !== current && <button type="button" onClick={() => setPage(Math.floor(selectedIndex / 12))}>定位{label}选择</button>}
        {pages > 1 && <>
          <button type="button" disabled={current === 0} aria-label={`上一页${label}`} onClick={() => setPage(current - 1)}>上一页</button>
          <span aria-live="polite">第 {current + 1} / {pages} 页</span>
          <button type="button" disabled={current === pages - 1} aria-label={`下一页${label}`} onClick={() => setPage(current + 1)}>下一页</button>
        </>}
      </div>
    </section>
  );
}

export function ThemePicker(props: { theme: ThemeId; onThemeChange: (theme: ThemeId) => void; showBackground?: boolean }) {
  const groupId = useId();
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
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
      <section className="theme-library-controls" aria-label="配色主题库">
        <h3>配色主题 · {THEMES.length}</h3>
        <p className="settings-section-description">改变界面颜色，无需下载。动态壁纸在下方背景库中独立选择。</p>
        <div className="theme-filters">
          <input type="search" aria-label="搜索配色主题" placeholder="搜索名称、描述" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select aria-label="配色主题分类" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">全部分类</option>
            {themeCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
      </section>
      {(["light", "dark"] as const).map((mode) => (
        <ThemeRow
          key={`${mode}-${category}-${query}`}
          mode={mode}
          query={query}
          category={category}
          selected={appearance.lastThemes[mode]}
          active={activeMode === mode}
          onSelect={props.onThemeChange}
        />
      ))}
      {props.showBackground !== false && <BackgroundPicker />}
    </div>
  );
}
