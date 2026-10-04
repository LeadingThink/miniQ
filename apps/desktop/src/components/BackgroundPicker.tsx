import { Check, Minus, Plus, Shuffle, SkipForward, Sparkles, ListOrdered } from "lucide-react";
import { useDeferredValue, useMemo, useState, useSyncExternalStore } from "react";
import { ambientThumbStyle } from "../ambient/ambientPresets";
import { getActiveBackground, storeBackground, subscribeBackground } from "../background";
import { BACKGROUND_GROUPS, BACKGROUNDS, type BackgroundDefinition } from "../backgroundCatalog";
import {
  advanceRotation,
  CUSTOM_LIMIT,
  getRotation,
  PLAYLISTS,
  resolveTimeSlot,
  restartRotationTimer,
  ROTATION_INTERVALS,
  subscribeRotation,
  toggleCustomBackground,
  updateRotation,
  type PlaylistId,
} from "../backgroundRotation";

export const PAGE_SIZE = 24;
const ALL_TAB = "全部";
const CUSTOM_TAB = "我的合集";

function BackgroundPreview({ background }: { background: BackgroundDefinition }) {
  if (background.thumb) {
    return (
      <span className="background-preview" aria-hidden="true">
        <img src={background.thumb} alt="" loading="lazy" draggable={false} />
      </span>
    );
  }
  if (background.kind === "ambient" && background.palette) {
    return <span className="background-preview" style={ambientThumbStyle(background.palette)} aria-hidden="true" />;
  }
  if (background.kind === "glyph") {
    return (
      <span
        className={`background-preview background-preview-glyph${background.light ? " is-light" : ""}`}
        style={{ color: background.accent }}
        aria-hidden="true"
      >
        <span>{background.name.slice(0, 2)}</span>
      </span>
    );
  }
  return (
    <span className="background-preview background-preview-none" aria-hidden="true">
      <Sparkles size={16} />
    </span>
  );
}

function BackgroundChoice({
  background,
  selected,
  inCustom,
  customFull,
}: {
  background: BackgroundDefinition;
  selected: boolean;
  inCustom: boolean;
  customFull: boolean;
}) {
  const canToggle = background.kind !== "none" && (inCustom || !customFull);
  return (
    <div className="background-choice">
      <label title={background.story}>
        <input
          type="radio"
          name="appearance-background"
          value={background.id}
          checked={selected}
          aria-label={background.name}
          onChange={() => {
            storeBackground(background.id);
            restartRotationTimer();
          }}
        />
        <BackgroundPreview background={background} />
        <span className="theme-copy">
          <strong>{background.name}</strong>
          {selected && <Check className="theme-check" size={14} aria-hidden="true" />}
        </span>
      </label>
      {background.kind !== "none" && (
        <button
          type="button"
          className={`background-collect${inCustom ? " is-collected" : ""}`}
          aria-label={inCustom ? `把${background.name}移出我的合集` : `把${background.name}加入我的合集`}
          aria-pressed={inCustom}
          title={canToggle ? undefined : `我的合集最多 ${CUSTOM_LIMIT} 张`}
          disabled={!canToggle}
          onClick={() => toggleCustomBackground(background.id)}
        >
          {inCustom ? <Minus size={12} /> : <Plus size={12} />}
        </button>
      )}
    </div>
  );
}

function RotationPanel() {
  const rotation = useSyncExternalStore(subscribeRotation, getRotation, getRotation);
  const playlist = PLAYLISTS.find((item) => item.id === rotation.playlistId)!;
  const detail =
    rotation.playlistId === "timeline"
      ? `${playlist.description}。现在是${resolveTimeSlot().name}。`
      : rotation.playlistId === "custom"
        ? rotation.custom.length
          ? `${rotation.custom.length} 张。${playlist.description}。`
          : `还没有壁纸。${playlist.description}。`
        : `${playlist.items?.length ?? 0} 张。${playlist.description}。`;
  return (
    <div className="background-rotation">
      <div className="background-rotation-head">
        <label className="background-rotation-toggle">
          <input
            type="checkbox"
            data-testid="rotation-toggle"
            checked={rotation.enabled}
            onChange={(event) => updateRotation({ enabled: event.target.checked })}
          />
          <span>自动轮播</span>
        </label>
        <select
          aria-label="轮播间隔"
          value={rotation.interval}
          onChange={(event) => updateRotation({ interval: Number(event.target.value) })}
        >
          {ROTATION_INTERVALS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 60 ? "每 1 小时" : `每 ${minutes} 分钟`}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="background-rotation-button"
          aria-label={rotation.order === "shuffle" ? "随机播放，点击改为顺序播放" : "顺序播放，点击改为随机播放"}
          onClick={() => updateRotation({ order: rotation.order === "shuffle" ? "sequence" : "shuffle" })}
        >
          {rotation.order === "shuffle" ? <Shuffle size={14} /> : <ListOrdered size={14} />}
          <span>{rotation.order === "shuffle" ? "随机" : "顺序"}</span>
        </button>
        <button
          type="button"
          className="background-rotation-button"
          data-testid="rotation-next"
          onClick={() => advanceRotation()}
        >
          <SkipForward size={14} />
          <span>下一张</span>
        </button>
      </div>
      <div className="background-chips" role="radiogroup" aria-label="壁纸合集">
        {PLAYLISTS.map((item) => (
          <label key={item.id} className="background-chip" title={item.description}>
            <input
              type="radio"
              name="appearance-playlist"
              value={item.id}
              checked={rotation.playlistId === item.id}
              onChange={() => updateRotation({ playlistId: item.id as PlaylistId })}
            />
            <span>{item.name}</span>
          </label>
        ))}
      </div>
      <p className="background-rotation-detail">{detail}</p>
    </div>
  );
}

function matches(item: BackgroundDefinition, query: string) {
  if (!query) return true;
  return [item.name, item.story, item.group].some((text) => text.toLowerCase().includes(query));
}

export function BackgroundPicker() {
  const active = useSyncExternalStore(subscribeBackground, getActiveBackground, getActiveBackground);
  const rotation = useSyncExternalStore(subscribeRotation, getRotation, getRotation);
  const [tab, setTab] = useState(ALL_TAB);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const query = useDeferredValue(search.trim().toLowerCase());

  const customSet = useMemo(() => new Set(rotation.custom), [rotation.custom]);
  const items = useMemo(() => {
    let list: readonly BackgroundDefinition[];
    if (tab === CUSTOM_TAB) {
      list = rotation.custom.map((id) => BACKGROUNDS.find((item) => item.id === id)!).filter(Boolean);
    } else if (tab === ALL_TAB) list = BACKGROUNDS;
    else list = BACKGROUNDS.filter((item) => item.group === tab);
    return list.filter((item) => matches(item, query));
  }, [tab, query, rotation.custom]);

  const selectTab = (next: string) => {
    setTab(next);
    setLimit(PAGE_SIZE);
  };
  const customFull = rotation.custom.length >= CUSTOM_LIMIT;
  const tabs = [ALL_TAB, ...BACKGROUND_GROUPS, CUSTOM_TAB];

  return (
    <section className="background-row" aria-label="背景">
      <h3>
        背景<span>{active.kind === "none" ? "使用主题配色" : active.story}</span>
      </h3>
      <RotationPanel />
      <div className="background-toolbar">
        <div className="background-tabs" role="tablist" aria-label="背景分类">
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              className="background-tab"
              onClick={() => selectTab(name)}
            >
              {name === CUSTOM_TAB ? `${name} ${rotation.custom.length}` : name}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="background-search"
          placeholder="搜索壁纸"
          aria-label="搜索壁纸"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(PAGE_SIZE);
          }}
        />
      </div>
      <div className="background-grid" role="radiogroup" aria-label="背景">
        {items.slice(0, limit).map((item) => (
          <BackgroundChoice
            key={item.id}
            background={item}
            selected={active.id === item.id}
            inCustom={customSet.has(item.id)}
            customFull={customFull}
          />
        ))}
      </div>
      {!items.length && (
        <p className="background-empty">
          {tab === CUSTOM_TAB && !query
            ? "我的合集还是空的。在壁纸卡片上点「+」加入。"
            : "没有找到匹配的背景，换个关键词试试"}
        </p>
      )}
      {items.length > limit && (
        <button type="button" className="background-more" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
          显示更多（还有 {items.length - limit} 个）
        </button>
      )}
      <p className="settings-section-description">
        视频壁纸首次选择时下载（约 3–8 MB）并缓存在本机；离线时显示静态封面。光影氛围和字符效果由程序绘制，不下载素材。
      </p>
    </section>
  );
}
