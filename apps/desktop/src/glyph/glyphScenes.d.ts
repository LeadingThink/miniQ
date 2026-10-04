export interface GlyphScene {
  id: string;
  name: string;
  light: boolean;
  desc: string;
  init(): void;
  frame(t: number, dt: number): void;
}

export interface GlyphEngine {
  scenes: GlyphScene[];
  select(id: string): void;
  resize(): void;
  setSpeed(value: number): void;
  start(): void;
  stop(): void;
  renderOnce(): void;
  destroy(): void;
}

export function createGlyphEngine(canvas: HTMLCanvasElement, options?: { lowPower?: boolean }): GlyphEngine;
