// Living backgrounds ported from Zaiwen Web (web/src/theme/theme-backgrounds.ts).
// Covers and thumbnails ship with the app; the looping videos are downloaded
// from the CDN on first use and cached locally (see backgroundVideo.ts).

export type BackgroundKind = "none" | "video" | "glyph";

export interface BackgroundDefinition {
  id: string;
  name: string;
  story: string;
  group: string;
  kind: BackgroundKind;
  /** Remote loop for video wallpapers. */
  video?: string;
  /** Bundled full-size cover shown while the video loads or when it cannot play. */
  poster?: string;
  /** Bundled 360x202 thumbnail used by the picker. */
  thumb?: string;
  /** Glyph engine scene id. */
  scene?: string;
  accent: string;
  /** Light glyph scenes draw dark text on a pale canvas. */
  light?: boolean;
}

export const BACKGROUND_VIDEO_ORIGIN = "https://oss.zaiwen.top";
const VIDEO_BASE = `${BACKGROUND_VIDEO_ORIGIN}/themes/backgrounds`;
const assetBase = () => `${import.meta.env.BASE_URL ?? "/"}backgrounds`;

function wallpaper(id: string, name: string, group: string, story: string, accent: string): BackgroundDefinition {
  return {
    id,
    name,
    story,
    group,
    kind: "video",
    video: `${VIDEO_BASE}/${id}.mp4`,
    poster: `${assetBase()}/${id}.jpg`,
    thumb: `${assetBase()}/${id}-thumb.jpg`,
    accent,
  };
}

function glyph(scene: string, name: string, story: string, accent: string, light = false): BackgroundDefinition {
  return { id: `glyph-${scene}`, name, story, group: "字符效果", kind: "glyph", scene, accent, light };
}

export const NO_BACKGROUND = "none";

export const BACKGROUNDS: readonly BackgroundDefinition[] = [
  { id: NO_BACKGROUND, name: "纯净界面", story: "保留主题配色本身", group: "基础", kind: "none", accent: "#9aa0a6" },
  wallpaper("01-spacecat", "太空猫打盹", "可爱伙伴", "宇航服里的猫咪在舷窗边打着小呼噜", "#b3dafa"),
  wallpaper("02-spirits", "月光小生物", "可爱伙伴", "森林里的小精灵们在月光下慢慢眨眼", "#b7f1c9"),
  wallpaper("03-deskcat", "桌边猫", "可爱伙伴", "深夜书桌旁的猫，尾巴偶尔轻轻一摆", "#edc6a0"),
  wallpaper("04-rooftop", "天台少年", "动漫世界", "放学后的天台，风把云推得很慢", "#b1a9ec"),
  wallpaper("05-rainstore", "雨夜便利店", "动漫世界", "雨丝落在便利店门前，灯牌轻轻闪烁", "#bdd8f1"),
  wallpaper("06-summer", "夏日窗边", "动漫世界", "窗帘被夏风掀起，蝉声若有若无", "#fff1c6"),
  wallpaper("07-station", "月下电车站", "动漫世界", "最后一班电车还没来，月亮先到了", "#c3cdf9"),
  wallpaper("08-mecha", "机甲待机", "机械与宇宙", "机库里的机甲缓慢呼吸，指示灯明灭", "#7ae2f4"),
  wallpaper("09-nightcar", "午夜跑车", "机械与宇宙", "霓虹倒影在车身上缓缓流过", "#ed6c76"),
  wallpaper("10-space", "宇宙远航", "机械与宇宙", "飞船驶向星云深处，星光慢慢后退", "#aecafc"),
  wallpaper("11-gameroom", "深夜游戏房", "机械与宇宙", "屏幕光晕里，手柄指示灯一下一下地亮", "#bc94f6"),
  wallpaper("12-pixelcamp", "像素露营", "户外与游戏", "像素篝火噼啪作响，星星一格一格闪", "#ffc47a"),
  wallpaper("13-court", "黄昏球场", "户外与游戏", "夕阳把球场染成金色，篮网轻轻晃动", "#f9dbb0"),
  wallpaper("14-fishing", "湖畔垂钓", "户外与游戏", "湖面泛着细小的波纹，鱼线静静等待", "#c0dbd5"),
  glyph("bytes", "字节升腾", "十六进制字节从底部光源升起，渐渐溶进黑暗", "#9fb4ff"),
  glyph("globe", "字符星球", "字符组成的星球缓慢自转，边缘微微发光", "#7ae2f4"),
  glyph("sea", "数字海洋", "字符构成的海面随噪声起伏，泛着银光", "#86c8ff"),
  glyph("morph", "字符聚合", "散落的字符聚合成形，又再次散开", "#c7b7ff"),
  glyph("decode", "解码矩阵", "矩阵中的字符逐行解码，露出隐藏的词句", "#8df0c2"),
  glyph("tokens", "语义星云", "词元在浅色星云中漂浮、碰撞、连接", "#5b7cff", true),
  glyph("fountain", "字符瀑布", "字符像瀑布一样自上而下倾泻", "#7fd6ff"),
  glyph("contour", "字符等高线", "字符沿地形等高线缓慢流动", "#b2d7a8"),
  glyph("lattice", "晶格呼吸", "规整的字符晶格随呼吸明暗起伏", "#9ad1ff"),
  glyph("tide", "银色潮汐", "银色字符潮汐缓缓涨落", "#d6dde8"),
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
