import { Check, Minus, Plus, Shuffle, SkipForward, Sparkles, ListOrdered, Search } from "lucide-react";
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
import { Switch } from "./ui/Switch";
import "./BackgroundPicker.css";

export const PAGE_SIZE = 24;
const ALL_TAB = "全部";
const CUSTOM_TAB = "我的合集";

function BackgroundPreview({ background }: { background: BackgroundDefinition }) {
  if (background.thumb) {
    return (
      <span className="background-preview" aria-hidden="true">
        <img
          src={background.thumb}
          alt=""
          loading="lazy"
          draggable={false}
          style={{ objectPosition: background.position }}
        />
      </span>
    );
  }
  if (background.kind === "ambient" && background.palette) {
    return (
      <span className="background-preview" style={ambientThumbStyle(background.palette)} aria-hidden="true" />
    );
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
        <div>
          <h4>自动轮播</h4>
          <p>{rotation.enabled ? "已开启，按所选合集切换壁纸" : "已关闭，保持当前壁纸"}</p>
        </div>
        <Switch
          label="自动轮播"
          checked={rotation.enabled}
          onChange={(enabled) => updateRotation({ enabled })}
        />
      </div>
      <div className="background-rotation-controls">
        <label className="background-playlist-field">
          <span>壁纸合集</span>
          <select
            value={rotation.playlistId}
            onChange={(event) => updateRotation({ playlistId: event.target.value as PlaylistId })}
          >
            {PLAYLISTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>轮播间隔</span>
          <select
            value={rotation.interval}
            onChange={(event) => updateRotation({ interval: Number(event.target.value) })}
          >
            {ROTATION_INTERVALS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes === 60 ? "每 1 小时" : `每 ${minutes} 分钟`}
              </option>
            ))}
          </select>
        </label>
        <div className="background-rotation-actions">
          <button
            type="button"
            className="background-rotation-button"
            aria-label={
              rotation.order === "shuffle" ? "随机播放，点击改为顺序播放" : "顺序播放，点击改为随机播放"
            }
            onClick={() =>
              updateRotation({
                order: rotation.order === "shuffle" ? "sequence" : "shuffle",
              })
            }
          >
            {rotation.order === "shuffle" ? <Shuffle size={14} /> : <ListOrdered size={14} />}
            <span>{rotation.order === "shuffle" ? "随机" : "顺序"}</span>
          </button>
          <button
            type="button"
            className="background-rotation-button"
            aria-label="下一张壁纸"
            onClick={() => advanceRotation()}
          >
            <SkipForward size={14} />
            <span>下一张</span>
          </button>
        </div>
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
  const [category, setCategory] = useState(ALL_TAB);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const query = useDeferredValue(search.trim().toLowerCase());

  const customSet = useMemo(() => new Set(rotation.custom), [rotation.custom]);
  const items = useMemo(() => {
    let list: readonly BackgroundDefinition[];
    if (category === CUSTOM_TAB) {
      list = rotation.custom.map((id) => BACKGROUNDS.find((item) => item.id === id)!).filter(Boolean);
    } else if (category === ALL_TAB) list = BACKGROUNDS;
    else list = BACKGROUNDS.filter((item) => item.group === category);
    return list.filter((item) => matches(item, query));
  }, [category, query, rotation.custom]);

  const selectCategory = (next: string) => {
    setCategory(next);
    setLimit(PAGE_SIZE);
  };
  const customFull = rotation.custom.length >= CUSTOM_LIMIT;
  const categories = [ALL_TAB, ...BACKGROUND_GROUPS, CUSTOM_TAB];

  return (
    <section className="background-row" aria-label="背景">
      <div className="appearance-section-heading">
        <h3>
          背景壁纸<span>当前 · {active.name}</span>
        </h3>
        <p>{active.kind === "none" ? "保持纯净界面，或选一张喜欢的壁纸。" : active.story}</p>
      </div>
      <RotationPanel />
      <div className="appearance-filters">
        <div className="appearance-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            placeholder="搜索壁纸"
            aria-label="搜索壁纸"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(PAGE_SIZE);
            }}
          />
        </div>
        <select
          aria-label="背景分类"
          value={category}
          onChange={(event) => selectCategory(event.target.value)}
        >
          {categories.map((name) => (
            <option key={name} value={name}>
              {name === CUSTOM_TAB
                ? `${name} ${rotation.custom.length}`
                : name === ALL_TAB
                  ? "全部分类"
                  : name}
            </option>
          ))}
        </select>
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
          {category === CUSTOM_TAB && !query
            ? "我的合集还是空的。在壁纸卡片上点「+」加入。"
            : "没有找到匹配的背景，换个关键词试试"}
        </p>
      )}
      {items.length > limit && (
        <button
          type="button"
          className="background-more"
          onClick={() => setLimit((value) => value + PAGE_SIZE)}
        >
          显示更多（还有 {items.length - limit} 个）
        </button>
      )}
      <p className="settings-section-description">
        点击「+」收藏壁纸，可在轮播合集里选择「我的合集」。部分动态壁纸首次使用需下载。
      </p>
    </section>
  );
}
