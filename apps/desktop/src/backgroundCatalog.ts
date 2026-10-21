// Curated living wallpapers for the desktop and mobile appearance pickers.
// Every packaged video has a stable palette, a quiet reading area, and one
// localized motion source. The catalog intentionally excludes dense scene art.

import { ambientBackgrounds, type AmbientPaletteId, type AmbientStyle } from "./ambient/ambientPresets";

export type BackgroundKind = "none" | "video" | "glyph" | "ambient";

export interface BackgroundDefinition {
  id: string;
  name: string;
  story: string;
  group: string;
  kind: BackgroundKind;
  /** Local or remote loop for video wallpapers. */
  video?: string;
  /** Packaged media can play offline without the download cache. */
  bundled?: boolean;
  /** Full-size cover shown while the video loads or when it cannot play. */
  poster?: string;
  /** Thumbnail used by the picker. */
  thumb?: string;
  /** Slow Ken Burns drift for still covers. */
  drift?: boolean;
  /** Shared focal position for cover, video and portrait crops. */
  position?: string;
  /** Glyph engine scene id. */
  scene?: string;
  /** Ambient engine style and palette. */
  style?: AmbientStyle;
  palette?: AmbientPaletteId;
  accent: string;
  /** Light scenes draw dark content on a pale canvas. */
  light?: boolean;
}

export const BACKGROUND_VIDEO_ORIGIN = "https://oss.zaiwen.top";
const assetBase = () => `${import.meta.env.BASE_URL ?? "/"}backgrounds`;

function bundledVideo(
  id: string,
  name: string,
  group: string,
  story: string,
  accent: string,
  position = "50% 50%",
  light = false,
): BackgroundDefinition {
  const base = assetBase();
  return {
    id,
    name,
    story,
    group,
    kind: "video",
    video: `${base}/${id}.mp4`,
    poster: `${base}/${id}.jpg`,
    thumb: `${base}/${id}-thumb.jpg`,
    bundled: true,
    drift: false,
    position,
    accent,
    ...(light ? { light: true } : {}),
  };
}

function remoteVideo(
  id: string, base: string, name: string, group: string, story: string,
  accent: string, position = "50% 50%", light = false,
): BackgroundDefinition {
  return {
    id, name, group, story, kind: "video", accent, position, light, drift: false,
    video: `${BACKGROUND_VIDEO_ORIGIN}/${base}/${id}.mp4`,
    poster: `${BACKGROUND_VIDEO_ORIGIN}/${base}/${id}-poster.jpg`,
    thumb: `${BACKGROUND_VIDEO_ORIGIN}/${base}/${id}-thumb.jpg`,
  };
}

function glyph(scene: string, name: string, story: string, accent: string, light = false): BackgroundDefinition {
  return { id: `glyph-${scene}`, name, story, group: "字符效果", kind: "glyph", scene, accent, light };
}

export const NO_BACKGROUND = "none";

export const BACKGROUNDS: readonly BackgroundDefinition[] = [
  { id: NO_BACKGROUND, name: "纯净界面", story: "保留主题配色本身", group: "基础", kind: "none", accent: "#9aa0a6" },
  bundledVideo("quiet-moonwater", "墨色月汐", "自然风景", "月光只留在低处的水纹上，背景保持安静", "#9baab4", "59% 50%"),
  bundledVideo("quiet-shore", "雾岸旅人", "人物风景", "一个人站在雾岸边，衣摆和远水慢慢呼吸", "#8fa7b6", "76% 50%", true),
  bundledVideo("quiet-fox", "苔林小憩", "动物伙伴", "狐狸在苔色树林里睡着，只有呼吸和薄雾在动", "#9c9879", "28% 50%"),
  bundledVideo("quiet-clay", "奶杏几何", "立体构成", "哑光几何体和玻璃球留在柔和的奶杏光里", "#cda38b", "58% 50%", true),
  bundledVideo("quiet-whale", "深海慢游", "动物伙伴", "一头小鲸鱼在深海里缓慢悬游，水光保持克制", "#78a7b0", "55% 50%"),
  bundledVideo("quiet-anime-sky", "云边读者", "原创动漫", "原创动画人物坐在云边读书，云层缓慢漂过天空", "#a4a2c5", "50% 50%", true),
  bundledVideo("quiet-desert", "沙色远行", "人物风景", "远处的旅人站在沙色盐地，尘雾沿地面轻轻移动", "#c99574", "100% 50%", true),
  bundledVideo("quiet-greenhouse", "薄荷温室", "室内植物", "薄荷色玻璃温室里，叶影在雾面玻璃上缓慢变化", "#8fab8e", "28% 50%", true),
  bundledVideo("quiet-anime-rain", "淡紫雨幕", "原创动漫", "伞下的原创动画人物静立，细雨落进淡紫雾气", "#aba8c1", "15% 50%", true),
  {
    id: "14-fishing", name: "湖畔垂钓", group: "自然风景", kind: "video",
    story: "暖色晨光映着平静湖面，垂钓者留在岸边", accent: "#c0b4a0",
    video: `${BACKGROUND_VIDEO_ORIGIN}/themes/backgrounds/14-fishing.mp4`,
    poster: `${assetBase()}/14-fishing.jpg`, thumb: `${assetBase()}/14-fishing-thumb.jpg`,
    position: "78% 50%", drift: false,
  },
  remoteVideo("w024", "web/wallpapers/living/pack-02", "蓝调雪溪", "自然风景", "蓝色雪地围着溪流，光点与水面缓慢变化", "#9fb9d8"),
  remoteVideo("p004", "web/wallpapers/themes/people", "雪地围巾男性", "人物风景", "背影留在雪地一侧，大片灰白空地保持安静", "#b2b7c1", "24% 50%", true),
  remoteVideo("p009", "web/wallpapers/themes/people", "屋顶星空女性", "人物风景", "人物坐在屋顶边缘，深蓝夜空留出宽阔空白", "#8594b1", "74% 50%"),
  remoteVideo("p013", "web/wallpapers/themes/people", "古风湖畔撑船女性", "人物风景", "小舟停在雾色湖面，浅暖光色与涟漪缓慢变化", "#c8bbb3", "74% 50%", true),
  remoteVideo("a010", "web/wallpapers/themes/anime", "蓝调校园空走廊", "原创动漫", "蓝色空走廊与低处反光构成安静的透视空间", "#8098bc"),
  remoteVideo("t009", "web/wallpapers/themes/technology", "深海实验舱", "立体构成", "实验舱留在深海一侧，中央水域保持低对比", "#5c91ac", "68% 50%"),
  glyph("bytes", "字节升腾", "十六进制字节从底部光源升起，渐渐溶进黑暗", "#9fb4ff"),
  glyph("globe", "字符星球", "字符组成的星球缓慢自转，边缘微微发光", "#7ae2f4"),
  glyph("sea", "数字海洋", "字符构成的海面随噪声起伏，泛着银光", "#86c8ff"),
  glyph("morph", "字符聚合", "散落的字符聚合成形，又再次散开", "#c7b7ff"),
  glyph("tokens", "语义星云", "词元在浅色星云中漂浮、碰撞、连接", "#5b7cff", true),
  glyph("fountain", "字符瀑布", "字符像瀑布一样自上而下倾泻", "#7fd6ff"),
  glyph("contour", "字符等高线", "字符沿地形等高线缓慢流动", "#b2d7a8"),
  glyph("lattice", "晶格呼吸", "规整的字符晶格随呼吸明暗起伏", "#9ad1ff"),
  glyph("tide", "银色潮汐", "银色字符潮汐缓缓涨落", "#d6dde8"),
  glyph("orbit", "轨道协议", "字符沿轨道环绕运行，像一组协议在握手", "#c5b2ff"),
  glyph("syntax", "流动语法", "代码片段如河流般缓缓流过屏幕", "#8fe3c8"),
  ...ambientBackgrounds,
];

const byId = new Map(BACKGROUNDS.map((item) => [item.id, item]));

export const BACKGROUND_GROUPS: readonly string[] = Array.from(
  new Set(BACKGROUNDS.filter((item) => item.kind !== "none").map((item) => item.group)),
);

export function isBackgroundId(value: unknown): value is string {
  return typeof value === "string" && byId.has(value);
}

export function getBackground(id: string): BackgroundDefinition {
  return byId.get(id) ?? byId.get(NO_BACKGROUND)!;
}
