export type ThemeMode = "light" | "dark";

export type ThemeDefinition = {
  id: string;
  name: string;
  description: string;
  mode: ThemeMode;
  /** 同一配色在另一种明暗下的对应主题，“跟随系统”时据此切换。 */
  pair: string;
  preview: {
    page: string;
    sidebar: string;
    surface: string;
    accent: string;
    text: string;
  };
};

type Palette = readonly [page: string, sidebar: string, surface: string, accent: string, text: string];

function theme<Id extends string>(
  id: Id,
  name: string,
  description: string,
  mode: ThemeMode,
  pair: string,
  palette: Palette,
): ThemeDefinition & { id: Id } {
  const [page, sidebar, surface, accent, text] = palette;
  return { id, name, description, mode, pair, preview: { page, sidebar, surface, accent, text } };
}

/**
 * 精选 6 套：3 组配色 × 浅色/深色。界面让位于内容，不再提供花纹与角色水印。
 */
export const themeCatalog = [
  theme("jade", "浅玉", "纸白与松石绿", "light", "night", ["#f4f5f1", "#ecefe9", "#ffffff", "#14775f", "#17191d"]),
  theme("snow", "素白", "中性灰白与系统蓝", "light", "slate", ["#f5f5f7", "#ececef", "#ffffff", "#0066cc", "#1d1d1f"]),
  theme("amber", "琥珀", "暖纸色与琥珀强调", "light", "graphite", ["#f7f6f2", "#efede6", "#fffefd", "#a96012", "#28231d"]),
  theme("night", "夜墨", "安静的深绿灰", "dark", "jade", ["#181c1a", "#202522", "#252a27", "#32a982", "#f2f5f3"]),
  theme("slate", "深空", "中性深灰与亮蓝", "dark", "snow", ["#1c1c1e", "#232326", "#2c2c2e", "#4c9dff", "#f5f5f7"]),
  theme("graphite", "石墨", "深灰与橙色强调", "dark", "amber", ["#161819", "#202326", "#282c2f", "#e17632", "#f4f3f1"]),
] as const satisfies readonly ThemeDefinition[];

export type ThemeId = (typeof themeCatalog)[number]["id"];

/** 旧版 100 余套主题按明暗与强调色色相迁移到最接近的精选主题。 */
export const LEGACY_THEMES: Record<string, ThemeId> = {
  rose: "amber",
  grid: "snow",
  ocean: "snow",
  forest: "jade",
  ink: "snow",
  blueprint: "slate",
  sky: "snow",
  iris: "snow",
  "moss-path": "jade",
  "pine-wind": "jade",
  "reed-bank": "amber",
  "coral-tide": "amber",
  glacier: "snow",
  canyon: "amber",
  "bamboo-rain": "jade",
  "lavender-field": "snow",
  "desert-bloom": "jade",
  "aurora-lake": "night",
  "volcanic-ash": "graphite",
  "peach-orchard": "amber",
  "wind-meadow": "jade",
  "cloud-post": "snow",
  "forest-station": "jade",
  "flying-workshop": "amber",
  "lamp-house": "graphite",
  "moon-library": "slate",
  "little-planet": "snow",
  "tea-clock": "amber",
  "whale-letter": "snow",
  "seed-airship": "amber",
  "snow-cabin": "amber",
  "midnight-carousel": "graphite",
  "lemon-spark": "amber",
  "spark-buddy": "snow",
  "mint-soda": "jade",
  "berry-milk": "amber",
  "orange-catnap": "amber",
  "grape-jelly": "snow",
  "blue-bubble": "snow",
  "melon-day": "amber",
  "candy-check": "amber",
  "pixel-pet": "night",
  "arcade-pop": "graphite",
  "rainbow-pencil": "snow",
  "notebook-blue": "snow",
  architect: "amber",
  "pencil-margin": "snow",
  "editorial-red": "amber",
  "legal-pad": "snow",
  "kraft-note": "amber",
  "receipt-roll": "jade",
  "comic-panel": "snow",
  "music-sheet": "snow",
  "field-journal": "amber",
  blackboard: "graphite",
  "dark-notebook": "slate",
  "film-cream": "amber",
  "vinyl-jazz": "graphite",
  newsprint: "snow",
  typewriter: "amber",
  "radio-dial": "graphite",
  seventies: "amber",
  cassette: "graphite",
  "mint-terminal": "night",
  postcard: "snow",
  "apricot-kitchen": "amber",
  "library-card": "snow",
  darkroom: "graphite",
  "quantum-blue": "slate",
  "neon-mint": "night",
  orbital: "graphite",
  "magenta-core": "graphite",
  "cyber-lime": "graphite",
  "holo-ice": "snow",
  "solar-array": "graphite",
  "signal-red": "graphite",
  "bio-lab": "jade",
  "violet-terminal": "slate",
  "deep-scan": "night",
  "white-module": "snow",
  "spring-rain": "jade",
  "peach-blossom": "amber",
  "grain-rain": "amber",
  "early-summer": "jade",
  midsummer: "jade",
  "lotus-night": "graphite",
  "white-dew": "snow",
  "maple-frost": "amber",
  "golden-field": "amber",
  "first-snow": "jade",
  "winter-solstice": "graphite",
  "new-year-paper": "amber",
  starry: "slate",
  obsidian: "slate",
  "midnight-rose": "graphite",
  "deep-forest": "night",
  "indigo-rain": "slate",
  "ember-room": "graphite",
  "violet-dusk": "slate",
  "navy-office": "slate",
  "red-moon": "graphite",
  "polar-night": "night",
  "coffee-code": "graphite",
  "quiet-terminal": "night",
  paper: "jade",
  mist: "snow",
  grove: "jade",
  sunrise: "amber",
  midnight: "slate",
  aurora: "night",
};
