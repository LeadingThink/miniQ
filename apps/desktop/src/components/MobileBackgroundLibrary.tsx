import { Check, ChevronLeft, ChevronRight, Minus, Plus, Heart, Shuffle, ListOrdered } from "lucide-react";
import { useId, useDeferredValue, useMemo, useState, useSyncExternalStore } from "react";
import { ambientThumbStyle } from "../ambient/ambientPresets";
import { BACKGROUND_GROUPS, BACKGROUNDS, type BackgroundDefinition } from "../backgroundCatalog";
import { CUSTOM_LIMIT, PLAYLISTS, ROTATION_INTERVALS, type PlaylistId, type RotationState } from "../backgroundRotation";
import { mobileBackgroundPolicy } from "../mobileBackgroundPolicy";
import "./MobileBackgroundLibrary.css";

const PAGE_SIZE = 12;
const ALL = "全部";
const CUSTOM = "我的合集";

function useSnapshot() {
  return useSyncExternalStore(
    (listener) => mobileBackgroundPolicy.subscribe(listener),
    () => mobileBackgroundPolicy.getSnapshot(),
    () => mobileBackgroundPolicy.getSnapshot(),
  );
}

function Preview({ item }: { item: BackgroundDefinition }) {
  if (item.thumb) return <img src={item.thumb} alt="" loading="lazy" draggable={false} />;
  if (item.kind === "ambient" && item.palette) return <span style={ambientThumbStyle(item.palette)} />;
  if (item.kind === "glyph") return <span className={`mobile-background-library-glyph${item.light ? " is-light" : ""}`} style={{ color: item.accent }}>{item.name.slice(0, 2)}</span>;
  return <span className="mobile-background-library-none">无</span>;
}

function matches(item: BackgroundDefinition, query: string) {
  return !query || [item.name, item.story, item.group].some((value) => value.toLowerCase().includes(query));
}

export interface MobileBackgroundLibraryProps {
  className?: string;
  pageSize?: number;
}

export function MobileBackgroundLibrary({ className = "", pageSize = PAGE_SIZE }: MobileBackgroundLibraryProps) {
  const groupId = useId();
  const snapshot = useSnapshot();
  const [tab, setTab] = useState(ALL);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const query = useDeferredValue(search.trim().toLowerCase());
  const rotation = snapshot.preferences.rotation;
  const customSet = useMemo(() => new Set(rotation.custom), [rotation.custom]);
  const favorites = snapshot.preferences.favorites;
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const active = snapshot.preferences.background;
  const tabs = [ALL, ...BACKGROUND_GROUPS, CUSTOM];
  const items = useMemo(() => {
    const source = tab === CUSTOM
      ? rotation.custom.map((id) => BACKGROUNDS.find((item) => item.id === id)).filter((item): item is BackgroundDefinition => Boolean(item))
      : tab === ALL ? BACKGROUNDS : BACKGROUNDS.filter((item) => item.group === tab);
    return source.filter((item) => matches(item, query) && (!favoritesOnly || favoriteSet.has(item.id)));
  }, [query, rotation.custom, tab, favoritesOnly, favoriteSet]);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = items.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const customFull = rotation.custom.length >= CUSTOM_LIMIT;

  const changeTab = (next: string) => { setTab(next); setPage(0); };
  const changeSearch = (value: string) => { setSearch(value); setPage(0); };
  const setRotation = (patch: Partial<RotationState>) => mobileBackgroundPolicy.setPreferences({ rotation: { ...rotation, ...patch } });
  const toggleCustom = (item: BackgroundDefinition) => {
    if (item.kind === "none") return;
    const custom = customSet.has(item.id) ? rotation.custom.filter((id) => id !== item.id) : [...rotation.custom, item.id];
    if (custom.length <= CUSTOM_LIMIT) setRotation({ custom });
  };

  return (
    <section className={`mobile-background-library ${className}`.trim()} aria-label="移动背景库">
      <div className="mobile-background-library-heading">
        <div><p className="mobile-background-library-eyebrow">移动背景</p><h2>背景库</h2></div>
        <span className="mobile-background-library-count">{items.length} 张</span>
      </div>
      <div className="mobile-background-library-toolbar">
        <button type="button" className="mobile-background-library-filter" aria-pressed={favoritesOnly} onClick={() => { setFavoritesOnly((value) => !value); setPage(0); }}><Heart size={16} />仅看收藏（{favorites.length}）</button>
        <input type="search" value={search} onChange={(event) => changeSearch(event.target.value)} placeholder="搜索背景" aria-label="搜索背景" />
        <div className="mobile-background-library-tabs" role="tablist" aria-label="背景分组">
          {tabs.map((name) => <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => changeTab(name)}>{name === CUSTOM ? `${name} ${rotation.custom.length}` : name}</button>)}
        </div>
      </div>
      <div className="mobile-background-library-rotation" aria-label="合集轮播设置">
        <label className="mobile-background-library-switch"><input type="checkbox" checked={rotation.enabled} onChange={(event) => setRotation({ enabled: event.target.checked })} /><span>合集轮播</span></label>
        <select aria-label="轮播间隔" value={rotation.interval} onChange={(event) => setRotation({ interval: Number(event.target.value) })}>
          {ROTATION_INTERVALS.map((minutes) => <option value={minutes} key={minutes}>{minutes === 60 ? "每 1 小时" : `每 ${minutes} 分钟`}</option>)}
        </select>
        <select aria-label="轮播合集" value={rotation.playlistId} onChange={(event) => setRotation({ playlistId: event.target.value as PlaylistId })}>
          {PLAYLISTS.map((playlist) => <option value={playlist.id} key={playlist.id}>{playlist.name}</option>)}
        </select>
        <button type="button" className="mobile-background-library-order" aria-label={rotation.order === "shuffle" ? "随机播放" : "顺序播放"} onClick={() => setRotation({ order: rotation.order === "shuffle" ? "sequence" : "shuffle" })}>
          {rotation.order === "shuffle" ? <Shuffle size={16} /> : <ListOrdered size={16} />}<span>{rotation.order === "shuffle" ? "随机" : "顺序"}</span>
        </button>
      </div>
      <div className="mobile-background-library-grid" role="radiogroup" aria-label="背景选择">
        {visible.map((item) => {
          const collected = customSet.has(item.id);
          const canToggle = item.kind !== "none" && (collected || !customFull);
          return <article className={`mobile-background-library-card${active === item.id ? " is-selected" : ""}`} key={item.id}>
            <label title={item.story}>
              <input type="radio" name={groupId} value={item.id} checked={active === item.id} onChange={() => mobileBackgroundPolicy.selectBackground(item.id)} aria-label={item.name} />
              <span className="mobile-background-library-preview"><Preview item={item} /></span>
              <span className="mobile-background-library-name">{item.name}</span>
              {active === item.id && <Check size={16} aria-hidden="true" />}
            </label>
            <div className="mobile-background-library-actions">
            {item.kind !== "none" && <button type="button" className="mobile-background-library-favorite" aria-label={`${favoriteSet.has(item.id) ? "取消收藏" : "收藏"}${item.name}`} aria-pressed={favoriteSet.has(item.id)} onClick={() => { mobileBackgroundPolicy.setPreferences({ favorites: favoriteSet.has(item.id) ? favorites.filter((id) => id !== item.id) : [...favorites, item.id] }); setPage(currentPage); }}><Heart size={16} fill={favoriteSet.has(item.id) ? "currentColor" : "none"} /></button>}
            {item.kind !== "none" && <button type="button" className={`mobile-background-library-collection${collected ? " is-collected" : ""}`} disabled={!canToggle} aria-label={collected ? `从我的合集移除${item.name}` : `加入我的合集${item.name}`} aria-pressed={collected} title={!canToggle ? `我的合集最多 ${CUSTOM_LIMIT} 张` : undefined} onClick={() => toggleCustom(item)}>{collected ? <Minus size={15} /> : <Plus size={15} />}</button>}
            </div>
          </article>;
        })}
      </div>
      {!visible.length && <p className="mobile-background-library-empty">{favoritesOnly ? "没有匹配的收藏，点背景卡片上的爱心收藏。" : tab === CUSTOM && !query ? "我的合集还是空的，点背景卡片上的「+」加入。" : "没有找到匹配的背景"}</p>}
      <div className="mobile-background-library-pagination" aria-label="背景分页">
        <button type="button" aria-label="上一页背景库" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18} /></button>
        <span aria-live="polite">第 {currentPage + 1} / {pages} 页</span>
        <button type="button" aria-label="下一页背景库" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={18} /></button>
      </div>
    </section>
  );
}
