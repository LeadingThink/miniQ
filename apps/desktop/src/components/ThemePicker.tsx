import { Check, ChevronLeft, ChevronRight, Heart, Moon, Search, Sun, X } from "lucide-react";
import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { getAppearance, storeCharacter, subscribeAppearance, toggleFavorite, THEMES, type ThemeId } from "../theme";
import { themeCategories, type ThemeDefinition } from "../themeCatalog";
import { themeCharacters } from "../themeCharacters";

const PAGE_SIZE = 12;

function CharacterPicker() {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const character = themeCharacters.find((item) => item.id === appearance.character)!;
  return (
    <details className="theme-characters">
      <summary>
        角色外观{" "}
        <span>
          {character.name} · {themeCharacters.length} 款
        </span>
      </summary>
      <div className="character-grid" role="radiogroup" aria-label="角色外观">
        {themeCharacters.map((item) => (
          <label key={item.id} className="character-choice" title={item.story}>
            <input
              type="radio"
              name="theme-character"
              value={item.id}
              aria-label={item.name}
              checked={appearance.character === item.id}
              onChange={() => storeCharacter(item.id)}
            />
            <span className="character-art" aria-hidden="true">
              {item.asset ? <img src={item.asset} alt="" loading="lazy" width="64" height="64" /> : <X size={22} />}
            </span>
            <strong>{item.name}</strong>
            <small>{item.universe}</small>
          </label>
        ))}
      </div>
    </details>
  );
}

function ThemeTile({
  theme,
  selected,
  favorite,
  onSelect,
}: {
  theme: (typeof THEMES)[number];
  selected: boolean;
  favorite: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="theme-tile" key={theme.id}>
      <label className="theme-choice">
        <input
          type="radio"
          name="appearance-theme"
          value={theme.id}
          checked={selected}
          aria-label={theme.name}
          onChange={onSelect}
        />
        <ThemePreview theme={theme} />
        <span className="theme-copy">
          <strong>{theme.name}</strong>
          <small>{theme.description}</small>
        </span>
        {selected && <Check className="theme-check" size={16} aria-hidden="true" />}
      </label>
      <button
        className="theme-favorite"
        type="button"
        aria-label={`${favorite ? "取消收藏" : "收藏"}${theme.name}`}
        title={`${favorite ? "取消收藏" : "收藏"}${theme.name}`}
        aria-pressed={favorite}
        onClick={() => toggleFavorite(theme.id)}
      >
        <Heart size={14} fill={favorite ? "currentColor" : "none"} />
      </button>
    </div>
  );
}

function ThemePreview({ theme }: { theme: ThemeDefinition }) {
  const style = Object.fromEntries(
    Object.entries(theme.preview).map(([key, value]) => [`--theme-${key}`, value])
  ) as CSSProperties;
  return (
    <span className="theme-preview" data-theme-pattern={theme.pattern} style={style} aria-hidden="true">
      <span className="theme-preview-sidebar">
        <i />
        <i />
        <i />
      </span>
      <span className="theme-preview-content">
        <i />
        <i />
        <b />
        <i />
      </span>
    </span>
  );
}

export function ThemePicker(props: { theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("featured");
  const [category, setCategory] = useState("all");
  const [mode, setMode] = useState("all");
  const [page, setPage] = useState(0);
  const selected = THEMES.find((theme) => theme.id === props.theme)!;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = THEMES.filter((theme) => {
    const categoryName = themeCategories.find((item) => item.id === theme.category)!.name;
    return (
      (scope !== "favorites" || appearance.favorites.includes(theme.id)) &&
      (scope !== "featured" || theme.featured) &&
      (category === "all" || theme.category === category) &&
      (mode === "all" || theme.mode === mode) &&
      (!normalizedQuery ||
        [theme.name, theme.description, theme.id, categoryName].some((value) =>
          value.toLocaleLowerCase().includes(normalizedQuery)
        ))
    );
  });
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const activePage = Math.min(page, Math.max(0, pageCount - 1));
  const visible = filtered.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE);
  const resetFilters = () => {
    setQuery("");
    setScope("all");
    setCategory("all");
    setMode("all");
    setPage(0);
  };

  return (
    <div className="appearance-settings">
      <div className="appearance-current">
        <ThemePreview theme={selected} />
        <div>
          <strong>{selected.name}</strong>
          <span>{selected.description}</span>
        </div>
        <div className="appearance-modes" role="group" aria-label="明暗外观">
          {(["light", "dark"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-label={value === "light" ? "浅色外观" : "深色外观"}
              title={value === "light" ? "浅色外观" : "深色外观"}
              aria-pressed={selected.mode === value}
              onClick={() => props.onThemeChange(appearance.lastThemes[value])}
            >
              {value === "light" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          ))}
        </div>
      </div>
      <CharacterPicker />
      <div className="theme-picker-heading">
        <h3>外观主题</h3>
        <span>{THEMES.length} 套</span>
      </div>
      <div className="theme-search">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          aria-label="搜索主题"
          placeholder="搜索主题"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (scope === "featured") setScope("all");
            setPage(0);
          }}
        />
      </div>
      <div className="theme-filters">
        <label>
          主题集
          <select
            aria-label="主题集"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value);
              setPage(0);
            }}
          >
            <option value="featured">精选 · {THEMES.filter((theme) => theme.featured).length}</option>
            <option value="all">全部 · {THEMES.length}</option>
            <option value="favorites">收藏 · {appearance.favorites.length}</option>
          </select>
        </label>
        <label>
          分类
          <select
            aria-label="主题分类"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
              if (scope === "featured") setScope("all");
              setPage(0);
            }}
          >
            <option value="all">所有分类</option>
            {themeCategories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          明暗
          <select
            aria-label="主题明暗"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">全部明暗</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
      </div>
      <div className="theme-grid" role="radiogroup" aria-label="外观主题">
        {visible.map((theme) => (
          <ThemeTile
            key={theme.id}
            theme={theme}
            selected={props.theme === theme.id}
            favorite={appearance.favorites.includes(theme.id)}
            onSelect={() => props.onThemeChange(theme.id)}
          />
        ))}
      </div>
      {filtered.length === 0 && (
        <div className="theme-empty" role="status">
          <span>{scope === "favorites" && !appearance.favorites.length ? "暂无收藏主题" : "没有匹配的主题"}</span>
          <button type="button" className="secondary" onClick={resetFilters}>
            查看全部
          </button>
        </div>
      )}
      <div className="theme-pagination">
        <span role="status" aria-live="polite">
          {filtered.length} 套{pageCount > 0 && ` · 第 ${activePage + 1} / ${pageCount} 页`}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="上一页主题"
          title="上一页主题"
          disabled={activePage === 0}
          onClick={() => setPage(activePage - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="下一页主题"
          title="下一页主题"
          disabled={activePage + 1 >= pageCount}
          onClick={() => setPage(activePage + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
