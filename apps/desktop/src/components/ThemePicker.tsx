import { Check, ChevronLeft, ChevronRight, Image, Palette, Search } from "lucide-react";
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
const THEMES_PER_PAGE = 6;

function previewStyle(theme: ThemeDefinition): CSSProperties {
  return Object.fromEntries(
    Object.entries(theme.preview).map(([key, value]) => [`--theme-${key}`, value]),
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
          ),
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
  const matches = THEMES.filter(
    (theme) =>
      theme.mode === props.mode &&
      (props.category === "all" || theme.category === props.category) &&
      [theme.id, theme.name, theme.description]
        .join(" ")
        .toLowerCase()
        .includes(props.query.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(matches.length / THEMES_PER_PAGE));
  const current = Math.min(page, pages - 1);
  const selectedIndex = matches.findIndex((theme) => theme.id === props.selected);
  const label = props.mode === "light" ? "浅色主题" : "深色主题";
  return (
    <section className="theme-row" aria-label={label}>
      <h3>
        {label}
        <span>{matches.length} 款</span>
        {props.active && <span className="theme-active-badge">使用中</span>}
      </h3>
      <div className="theme-grid" role="radiogroup" aria-label={label}>
        {matches.slice(current * THEMES_PER_PAGE, (current + 1) * THEMES_PER_PAGE).map((theme) => (
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
              <span
                className="theme-swatch"
                style={{ background: theme.preview.accent }}
                aria-hidden="true"
              />
              <strong>{theme.name}</strong>
              {props.selected === theme.id && <Check className="theme-check" size={14} aria-hidden="true" />}
            </span>
          </label>
        ))}
      </div>
      {!matches.length && (
        <p className="settings-section-description">没有匹配的配色主题，请调整搜索或分类。</p>
      )}
      <div className="theme-pagination" aria-label={`${label}分页`}>
        <span>已选：{themeById(props.selected).name}</span>
        {selectedIndex >= 0 && Math.floor(selectedIndex / THEMES_PER_PAGE) !== current && (
          <button
            type="button"
            className="theme-locate"
            aria-label={`定位${label}选择`}
            onClick={() => setPage(Math.floor(selectedIndex / THEMES_PER_PAGE))}
          >
            查看已选
          </button>
        )}
        {pages > 1 && (
          <div className="theme-page-controls">
            <button
              type="button"
              disabled={current === 0}
              aria-label={`上一页${label}`}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <span aria-live="polite">
              {current + 1} / {pages}
            </span>
            <button
              type="button"
              disabled={current === pages - 1}
              aria-label={`下一页${label}`}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function AppearanceModes() {
  const groupId = useId();
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const light = themeById(appearance.lastThemes.light);
  const dark = themeById(appearance.lastThemes.dark);
  return (
    <section className="appearance-mode-row" aria-label="外观">
      <div className="appearance-section-heading">
        <h3>显示模式</h3>
        <p>{appearance.mode === "system" ? "随系统自动切换浅色与深色" : "始终使用所选外观"}</p>
      </div>
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
            <span className="appearance-mode-caption">
              {mode.label}
              {appearance.mode === mode.id && <Check size={13} aria-hidden="true" />}
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

function ThemeLibrary(props: { theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const activeMode = themeById(props.theme).mode;
  return (
    <div className="theme-library">
      <AppearanceModes />
      <section className="theme-library-controls" aria-label="配色主题库">
        <div className="appearance-section-heading">
          <h3>
            配色主题<span>{THEMES.length} 款</span>
          </h3>
          <p>分别记住浅色与深色配色，自动模式随系统切换。</p>
        </div>
        <div className="appearance-filters">
          <div className="appearance-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索配色主题"
              placeholder="搜索主题名称或描述"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <select
            aria-label="配色主题分类"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">全部分类</option>
            {themeCategories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
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
    </div>
  );
}

export function ThemePicker(props: {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  showBackground?: boolean;
}) {
  const id = useId();
  const [tab, setTab] = useState("themes");
  const tabs = [
    { id: "themes", label: "配色主题", icon: Palette },
    { id: "backgrounds", label: "背景壁纸", icon: Image },
  ];
  return (
    <div className="appearance-settings">
      {props.showBackground === false ? (
        <ThemeLibrary {...props} />
      ) : (
        <>
          <div className="appearance-library-tabs" role="tablist" aria-label="外观设置">
            {tabs.map((item, index) => (
              <button
                key={item.id}
                id={`${id}-${item.id}-tab`}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                aria-controls={`${id}-${item.id}-panel`}
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => {
                  let next: number;
                  if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
                  else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = tabs.length - 1;
                  else return;
                  event.preventDefault();
                  setTab(tabs[next].id);
                  document.getElementById(`${id}-${tabs[next].id}-tab`)?.focus();
                }}
              >
                <item.icon size={15} aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </div>
          <div
            id={`${id}-themes-panel`}
            role="tabpanel"
            aria-labelledby={`${id}-themes-tab`}
            hidden={tab !== "themes"}
          >
            <ThemeLibrary {...props} />
          </div>
          <div
            id={`${id}-backgrounds-panel`}
            role="tabpanel"
            aria-labelledby={`${id}-backgrounds-tab`}
            hidden={tab !== "backgrounds"}
          >
            <BackgroundPicker />
          </div>
        </>
      )}
    </div>
  );
}
