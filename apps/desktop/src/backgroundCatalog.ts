// Living backgrounds ported from Zaiwen Web (web/src/theme/theme-backgrounds.ts).
// The original 14 wallpapers ship covers and thumbnails with the app; newer
// wallpapers load them from the CDN. Looping videos are downloaded on first
// use and cached locally (see backgroundVideo.ts). Ambient backgrounds are
// drawn procedurally and download nothing.

import { ambientBackgrounds, type AmbientPaletteId, type AmbientStyle } from "./ambient/ambientPresets";

export type BackgroundKind = "none" | "video" | "glyph" | "ambient";

export interface BackgroundDefinition {
  id: string;
  name: string;
  story: string;
  group: string;
  kind: BackgroundKind;
  /** Remote loop for video wallpapers. */
  video?: string;
  /** Full-size cover shown while the video loads or when it cannot play. */
  poster?: string;
  /** 360x202 thumbnail used by the picker. */
  thumb?: string;
  /** Slow Ken Burns drift over the video. Off for clips that already move the camera. */
  drift?: boolean;
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
const VIDEO_BASE = `${BACKGROUND_VIDEO_ORIGIN}/themes/backgrounds`;
const WALLPAPER_BASE = `${BACKGROUND_VIDEO_ORIGIN}/web/wallpapers`;
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

function remoteVideo(
  id: string,
  base: string,
  name: string,
  group: string,
  story: string,
  accent: string,
  drift?: boolean,
): BackgroundDefinition {
  return {
    id,
    name,
    story,
    group,
    kind: "video",
    video: `${base}/${id}.mp4`,
    poster: `${base}/${id}-poster.jpg`,
    thumb: `${base}/${id}-thumb.jpg`,
    accent,
    ...(drift === false ? { drift } : {}),
  };
}

/** Living wallpapers. pack-01 is mirrored from Zaiwen; later packs already use slow camera moves. */
function livingWallpaper(
  id: string,
  name: string,
  group: string,
  story: string,
  accent: string,
  pack = "pack-01",
): BackgroundDefinition {
  return remoteVideo(id, `${WALLPAPER_BASE}/living/${pack}`, name, group, story, accent, pack === "pack-01");
}

/** Theme wallpapers: people, anime and technology clips with their own camera motion. */
function themeWallpaper(
  id: string,
  name: string,
  group: string,
  story: string,
  theme: string,
  accent: string,
): BackgroundDefinition {
  return remoteVideo(id, `${WALLPAPER_BASE}/themes/${theme}`, name, group, story, accent, false);
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
  livingWallpaper("w001-lighthouse", "灯塔白猫", "海与岸", "白猫守着灯塔，海浪一遍遍拍上礁石", "#f2b880"),
  livingWallpaper("w002-sakura-river", "樱花河岸", "四季风景", "春风吹过河岸，花瓣慢慢落进水里", "#f6c1d3"),
  livingWallpaper("w003-autumn-temple", "秋日山寺", "四季风景", "红叶铺满石阶，寺里的风铃轻响", "#e98a4f"),
  livingWallpaper("w004-snow-cabin", "雪夜小屋", "四季风景", "大雪落在森林里，木屋窗口透出暖光", "#cfe3f7"),
  livingWallpaper("w005-summer-field", "夏日稻田", "四季风景", "风吹过稻田，远处的积雨云慢慢长高", "#9fd7a0"),
  livingWallpaper("w006-tokyo-alley", "霓虹小巷", "城市夜色", "雨后的小巷，霓虹招牌倒映在水洼里", "#f07aa8"),
  livingWallpaper("w007-city-window", "高楼窗景", "城市夜色", "深夜加班的窗外，城市灯火像星河", "#8fb4f2"),
  livingWallpaper("w008-tram-dusk", "黄昏电车", "城市夜色", "叮当电车穿过黄昏的坡道", "#f4b46c"),
  livingWallpaper("w009-bookcafe", "雨天书店", "城市夜色", "雨打在书店玻璃上，屋里是暖黄的灯", "#d9a66b"),
  livingWallpaper("w010-fox-forest", "森林小狐狸", "可爱伙伴", "萤火虫围着打盹的小狐狸飞", "#f2a65a"),
  livingWallpaper("w011-panda-bamboo", "竹林熊猫", "可爱伙伴", "熊猫抱着竹子，在雾里慢慢嚼", "#b6e3b0"),
  livingWallpaper("w012-corgi-beach", "海边柯基", "可爱伙伴", "柯基趴在沙滩上，看着浪花来来去去", "#f7d08a"),
  livingWallpaper("w013-owl-library", "猫头鹰书房", "可爱伙伴", "古老书房里，猫头鹰守着一盏烛灯", "#c9a26b"),
  livingWallpaper("w014-floating-island", "浮空岛", "奇幻世界", "瀑布从浮空岛边缘落进云海", "#9ad1f0"),
  livingWallpaper("w015-whale-sky", "天空鲸鱼", "奇幻世界", "一头巨鲸游过晚霞", "#f0a1c4"),
  livingWallpaper("w016-glow-mushroom", "发光蘑菇林", "奇幻世界", "蘑菇林在夜里亮起柔和的蓝光", "#7fe0e6"),
  livingWallpaper("w017-lantern-river", "河灯夜", "奇幻世界", "千盏河灯顺水漂向远方", "#f5c063"),
  livingWallpaper("w018-aurora-lake", "极光湖畔", "星空宇宙", "极光在雪山上方流动，倒映在湖面", "#7ff0c0"),
  livingWallpaper("w019-milkyway-hill", "银河山丘", "星空宇宙", "躺在山丘上，看银河慢慢转动", "#a5b4fc"),
  livingWallpaper("w020-planet-rings", "行星环", "星空宇宙", "巨大的行星环横跨天际", "#c4b5fd"),
  livingWallpaper("w021", "晨雾溪流", "自然风景", "晨雾停在山谷溪流上，蕨叶和石径安静地守着水声", "#a7c9c0", "pack-02"),
  livingWallpaper("w022", "雨中针叶林", "自然风景", "细雨落进针叶森林，溪水沿着石头缓缓流过", "#9bb9c9", "pack-02"),
  livingWallpaper("w023", "秋日山湖", "自然风景", "粉金色的秋日山湖映着木栈台，水面只有细小涟漪", "#e7b982", "pack-02"),
  livingWallpaper("w024", "蓝调雪溪", "自然风景", "蓝调雪夜里的白桦溪流，岸边一盏小灯守着安静的水面", "#9fb9d8", "pack-02"),
  livingWallpaper("w025", "夏日清潭", "自然风景", "细瀑落进夏日清潭，岩石和白花在水声里保持静谧", "#9ed3c4", "pack-02"),
  livingWallpaper("w026", "樱花溪谷", "自然风景", "晨光落在樱花溪谷，手绘般的花影映着缓慢流动的水面", "#e9b4c9", "pack-02"),
  livingWallpaper("w027", "高山蓝湖", "自然风景", "雪山围着清澈蓝湖，岸边卵石被柔和水纹轻轻擦亮", "#9dc7df", "pack-02"),
  livingWallpaper("w028", "雨后竹径", "自然风景", "雨后的竹林小径旁，石渠里的水流在晨光中缓慢前行", "#9fc9a8", "pack-02"),
  livingWallpaper("w029", "金秋山溪", "自然风景", "金色银杏映着山溪，暖光停在岩石与细水之间", "#d8ad65", "pack-02"),
  livingWallpaper("w041", "托斯卡纳石巷", "自然风景", "夕阳落在砖石小巷与藤蔓之间，远处的城镇安静铺开", "#d9a06f", "pack-03"),
  livingWallpaper("w042", "蓝窗海岸", "自然风景", "白墙蓝窗面向海湾，花卉和石阶在海风里保持明亮", "#9fc9df", "pack-03"),
  livingWallpaper("w043", "秋日雨椅", "自然风景", "雨后的长椅和树叶映在水洼里，远处街景慢慢亮起", "#c49b78", "pack-03"),
  livingWallpaper("w044", "拱廊运河", "自然风景", "石拱廊沿着运河延伸，远桥和水面涟漪带来安静层次", "#9bbfc1", "pack-03"),
  livingWallpaper("w045", "圆窗庭院", "自然风景", "圆窗框住庭院与柠檬树，远山被柔和光线轻轻托起", "#d4b36c", "pack-03"),
  livingWallpaper("w046", "雨窗海滨", "自然风景", "雨水掠过窗面，海滨步道和远处海色保持克制的流动", "#8fb8c7", "pack-03"),
  livingWallpaper("w047", "阁楼山谷", "自然风景", "阁楼天窗望向山谷，室内木梁与远景形成安静的框景", "#c7a783", "pack-03"),
  themeWallpaper("p001", "海风白衬衫女性侧影", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p002", "山顶风衣男性背影", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p003", "雨夜伞下女性", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p004", "雪地围巾男性", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p005", "沙漠旅人", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p006", "图书馆阅读女性", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p007", "森林提灯旅人", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p008", "海边吉他男性", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p009", "屋顶星空女性", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p010", "秋日咖啡窗边男性", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p011", "草原骑马女性", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p012", "古风竹林剑客", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p013", "古风湖畔撑船女性", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p014", "未来飞行员", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p015", "复古车站女旅客", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p016", "温室园丁", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p017", "都市夜跑男性", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p018", "雪山登山女性", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("p019", "岩岸灯塔守望者", "人物风景", "人物风景动态壁纸", "people", "#9fb4ff"),
  themeWallpaper("a001", "樱花河岸少女背影", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a002", "夏日海岸电车", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a003", "便利店雨夜", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a004", "云海浮空岛", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a005", "秋日神社石阶", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a006", "雪夜温泉街", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a007", "屋顶看流星成年青年", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a008", "森林小屋与猫", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a010", "蓝调校园空走廊", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a011", "黄昏海边自行车", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a012", "烟花河堤成年和服女性", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a013", "清晨玻璃花房", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a014", "水下遗迹与游鱼", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("a015", "月夜竹林原创旅人", "原创动漫", "原创动漫动态壁纸", "anime", "#9fb4ff"),
  themeWallpaper("t001", "蓝色数据晶体", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t002", "轨道空间站与地球", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t003", "雨夜未来城市", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t004", "白色极简机器人", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t005", "量子环形装置", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t006", "火星科考基地", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t007", "光纤森林", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t008", "黑金芯片微观", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t009", "深海实验舱", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t010", "紫色星际星云", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t011", "悬浮磁力列车", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t012", "透明全息几何球", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t013", "太阳能未来绿城", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t014", "月面天文台", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t015", "深空飞船舷窗", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t016", "银色液态金属波纹", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t017", "青色电路峡谷", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t018", "人工智能神经光网", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t019", "冰原天线阵列", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
  themeWallpaper("t020", "无限镜面光廊", "未来科技", "未来科技动态壁纸", "technology", "#9fb4ff"),
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
  glyph("fabric", "数据织物", "字符经纬交织成布，随风轻轻起伏", "#9cc3ff"),
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
