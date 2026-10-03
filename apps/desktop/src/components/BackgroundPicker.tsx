import { Check, Sparkles } from "lucide-react";
import { useSyncExternalStore } from "react";
import { getActiveBackground, storeBackground, subscribeBackground } from "../background";
import { BACKGROUND_GROUPS, BACKGROUNDS, type BackgroundDefinition } from "../backgroundCatalog";

function BackgroundPreview({ background }: { background: BackgroundDefinition }) {
  if (background.thumb) {
    return (
      <span className="background-preview" aria-hidden="true">
        <img src={background.thumb} alt="" loading="lazy" draggable={false} />
      </span>
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

function BackgroundChoice({ background, selected }: { background: BackgroundDefinition; selected: boolean }) {
  return (
    <label className="background-choice" title={background.story}>
      <input
        type="radio"
        name="appearance-background"
        value={background.id}
        checked={selected}
        aria-label={background.name}
        onChange={() => storeBackground(background.id)}
      />
      <BackgroundPreview background={background} />
      <span className="theme-copy">
        <strong>{background.name}</strong>
        {selected && <Check className="theme-check" size={14} aria-hidden="true" />}
      </span>
    </label>
  );
}

export function BackgroundPicker() {
  const active = useSyncExternalStore(subscribeBackground, getActiveBackground, getActiveBackground);
  const none = BACKGROUNDS.find((item) => item.kind === "none")!;
  return (
    <section className="background-row" aria-label="背景">
      <h3>
        背景<span>{active.kind === "none" ? "使用主题配色" : active.story}</span>
      </h3>
      <div className="background-groups" role="radiogroup" aria-label="背景">
        {["基础", ...BACKGROUND_GROUPS].map((group) => (
          <div key={group} className="background-group">
            <h4>{group}</h4>
            <div className="background-grid">
              {(group === "基础" ? [none] : BACKGROUNDS.filter((item) => item.group === group)).map((item) => (
                <BackgroundChoice key={item.id} background={item} selected={active.id === item.id} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="settings-section-description">
        视频壁纸首次选择时下载（约 3–6 MB）并缓存在本机；离线时显示静态封面。
      </p>
    </section>
  );
}
