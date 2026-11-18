export type AppPlatform = "miniq" | "zaiwen";

export const platforms = [
  { id: "zaiwen", name: "在问", description: "创作、学习和探索" },
  { id: "miniq", name: "miniQ", description: "构建、调试和发布" },
] as const;
