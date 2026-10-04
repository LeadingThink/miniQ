/**
 * Ambient catalog: 10 styles x 11 palettes = 110 procedural backgrounds.
 * Ported from Zaiwen Web (web/src/theme/ambient/ambient-presets.ts).
 * Holds only parameters (no images or videos); ambient-engine.ts loads on demand.
 */

export const ambientStyles = [
  { id: "aurora", name: "极光", story: "柔和的光带在夜空中缓缓飘动" },
  { id: "mesh", name: "流光", story: "大片柔光彼此交融，像缓慢流动的颜料" },
  { id: "bokeh", name: "光斑", story: "失焦的光斑轻轻上浮，忽明忽暗" },
  { id: "fireflies", name: "萤火", story: "点点萤火随意游走，一闪一闪" },
  { id: "stars", name: "星空", story: "繁星闪烁，偶尔划过一道流星" },
  { id: "waves", name: "海浪", story: "层层波浪交错起伏，节奏舒缓" },
  { id: "rain", name: "细雨", story: "细密雨丝斜斜落下，安静专注" },
  { id: "snow", name: "落雪", story: "雪花随风轻摆，慢慢飘落" },
  { id: "constellation", name: "星座", story: "光点缓慢漂移，靠近时连成星座" },
  { id: "ripples", name: "涟漪", story: "水面上一圈圈涟漪悄然荡开" },
] as const;

export type AmbientStyle = (typeof ambientStyles)[number]["id"];

export interface AmbientPalette {
  id: string;
  name: string;
  /** Background colors at the top and bottom. */
  bg: readonly [string, string];
  /** Motion colors; the first is also the card accent. */
  colors: readonly string[];
  light?: boolean;
}

export const ambientPalettes = [
  { id: "polar", name: "极地", bg: ["#020b16", "#04111f"], colors: ["#3ff0b4", "#2ec5ff", "#8f6bff"] },
  { id: "sakura", name: "樱花", bg: ["#14070f", "#1d0b18"], colors: ["#ff8fb8", "#ffc2d6", "#c78bff"] },
  { id: "ember", name: "余烬", bg: ["#120604", "#1a0905"], colors: ["#ff7a3d", "#ffb347", "#ff4d4d"] },
  { id: "ocean", name: "深海", bg: ["#020a14", "#03142a"], colors: ["#2fa8ff", "#22e1d6", "#4b6bff"] },
  { id: "forest", name: "森林", bg: ["#03100a", "#071a10"], colors: ["#7be495", "#d4f78a", "#3fcf8e"] },
  { id: "neon", name: "霓虹", bg: ["#07030f", "#0f0620"], colors: ["#ff3df2", "#3df5ff", "#7a5cff"] },
  { id: "gold", name: "鎏金", bg: ["#0e0a03", "#171006"], colors: ["#ffd36e", "#ffb84d", "#fff1b8"] },
  { id: "violet", name: "暮紫", bg: ["#0a0614", "#140b26"], colors: ["#b48cff", "#ff9ad5", "#7aa2ff"] },
  { id: "silver", name: "银灰", bg: ["#08090c", "#101217"], colors: ["#e6ebf5", "#9aa4b8", "#c8d0e0"] },
  { id: "dawn", name: "晨曦", bg: ["#fdf3ea", "#f4e6f6"], colors: ["#ff9f7a", "#f5b942", "#b98bff"], light: true },
  { id: "mint", name: "薄荷", bg: ["#eefaf6", "#e6f2fb"], colors: ["#2fbf96", "#4f9dff", "#7fcf5a"], light: true },
] as const satisfies readonly AmbientPalette[];

export type AmbientPaletteId = (typeof ambientPalettes)[number]["id"];
export type AmbientBackgroundId = `ambient-${AmbientStyle}-${AmbientPaletteId}`;

export const AMBIENT_GROUP = "光影氛围";

export interface AmbientBackgroundEntry {
  id: AmbientBackgroundId;
  name: string;
  story: string;
  group: typeof AMBIENT_GROUP;
  kind: "ambient";
  style: AmbientStyle;
  palette: AmbientPaletteId;
  accent: string;
  light: boolean;
}

/** Stable string hash used as the layout seed. */
export function hashSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const ambientBackgrounds: readonly AmbientBackgroundEntry[] = ambientStyles.flatMap(style =>
  ambientPalettes.map(palette => ({
    id: `ambient-${style.id}-${palette.id}` as AmbientBackgroundId,
    name: `${palette.name}${style.name}`,
    story: style.story,
    group: AMBIENT_GROUP,
    kind: "ambient" as const,
    style: style.id,
    palette: palette.id,
    accent: palette.colors[0],
    light: "light" in palette && palette.light === true,
  })),
);

const paletteMap = new Map<string, AmbientPalette>(ambientPalettes.map(item => [item.id, item]));

export function getAmbientPalette(id: string): AmbientPalette | undefined {
  return paletteMap.get(id);
}

/** Card thumbnail: CSS gradients only, no image requests. */
export function ambientThumbStyle(paletteId: string): Record<string, string> {
  const palette = paletteMap.get(paletteId);
  if (!palette) return {};
  const [c1, c2 = c1, c3 = c2] = palette.colors;
  return {
    background: [
      `radial-gradient(circle at 22% 30%, ${c1}cc 0, transparent 46%)`,
      `radial-gradient(circle at 78% 64%, ${c2}aa 0, transparent 50%)`,
      `radial-gradient(circle at 54% 110%, ${c3}99 0, transparent 55%)`,
      `linear-gradient(180deg, ${palette.bg[0]}, ${palette.bg[1]})`,
    ].join(", "),
  };
}
