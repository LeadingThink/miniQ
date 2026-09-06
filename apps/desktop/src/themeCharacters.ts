export type ThemeCharacterDefinition = {
  id: string;
  name: string;
  story: string;
  universe: string;
  asset: string | null;
  watermarkAsset: string | null;
};

/**
 * 角色与配色底板分开管理：新增一个角色包即可组合全部主题，
 * 不需要复制 108 份主题数据。第三方联名只有取得授权后才能进入这里。
 */
export const themeCharacters = [
  {
    id: "none",
    name: "纯净界面",
    story: "保留配色与纹理本身",
    universe: "基础",
    asset: null,
    watermarkAsset: null,
  },
  {
    id: "baize-young",
    name: "白泽",
    story: "陪你探索工具与灵感的知识伙伴",
    universe: "白泽",
    asset: "./themes/characters/baize-young.png",
    watermarkAsset: "./themes/characters/baize-young-watermark.png",
  },
  {
    id: "human-li-bai",
    name: "李白",
    story: "以诗酒与明月游历天地",
    universe: "人类星图",
    asset: "./themes/characters/human-li-bai.png",
    watermarkAsset: "./themes/characters/human-li-bai-watermark.png",
  },
  {
    id: "human-su-shi",
    name: "苏轼",
    story: "在诗文与烟火人间安顿旷达",
    universe: "人类星图",
    asset: "./themes/characters/human-su-shi.png",
    watermarkAsset: "./themes/characters/human-su-shi-watermark.png",
  },
  {
    id: "human-yue-fei",
    name: "岳飞",
    story: "以纪律、担当与坚守护卫家国",
    universe: "人类星图",
    asset: "./themes/characters/human-yue-fei.png",
    watermarkAsset: "./themes/characters/human-yue-fei-watermark.png",
  },
  {
    id: "human-zhang-heng",
    name: "张衡",
    story: "仰观星辰，俯察大地的汉代科学家",
    universe: "人类星图",
    asset: "./themes/characters/human-zhang-heng.png",
    watermarkAsset: "./themes/characters/human-zhang-heng-watermark.png",
  },
  {
    id: "human-isaac-newton",
    name: "牛顿",
    story: "从苹果、光谱与几何中追问自然",
    universe: "人类星图",
    asset: "./themes/characters/human-isaac-newton.png",
    watermarkAsset: "./themes/characters/human-isaac-newton-watermark.png",
  },
  {
    id: "human-ada-lovelace",
    name: "阿达·洛芙莱斯",
    story: "在机械齿轮里预见计算的未来",
    universe: "人类星图",
    asset: "./themes/characters/human-ada-lovelace.png",
    watermarkAsset: "./themes/characters/human-ada-lovelace-watermark.png",
  },
  {
    id: "human-leonardo-da-vinci",
    name: "达·芬奇",
    story: "让艺术、观察与工程在笔记中相遇",
    universe: "人类星图",
    asset: "./themes/characters/human-leonardo-da-vinci.png",
    watermarkAsset: "./themes/characters/human-leonardo-da-vinci-watermark.png",
  },
  {
    id: "human-socrates",
    name: "苏格拉底",
    story: "以提问照亮思考与自知之路",
    universe: "人类星图",
    asset: "./themes/characters/human-socrates.png",
    watermarkAsset: "./themes/characters/human-socrates-watermark.png",
  },
] as const satisfies readonly ThemeCharacterDefinition[];

export type ThemeCharacterId = (typeof themeCharacters)[number]["id"];
