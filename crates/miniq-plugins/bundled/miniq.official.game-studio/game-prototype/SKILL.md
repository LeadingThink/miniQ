---
name: game-prototype
description: 当用户要用 Phaser、Three.js 或 Canvas 快速做出可玩的网页游戏原型，并生成美术和音乐素材时使用
origin: installed
requires:
  bins:
    - npx
---

## 适用场景

已有 GDD（或用户口头描述足够清楚），需要在本地搭出能在浏览器里玩的原型，并用 AI 生成占位或正式素材。

## 前置条件

- Node.js 18+（`shell_run`: `node -v`）
- 若存在 `docs/GDD.md`，先用 `file_read` 读取

## 步骤

1. **创建 Vite 工程**（`shell_run`；目录非空时先 `ask_user`）：
   - 2D / Canvas：`npm create vite@latest <name> -- --template vanilla-ts`
   - 然后：`cd <name> && npm install`
   - Phaser 额外执行 `npm i phaser`
   - Three.js 额外执行 `npm i three` 和 `npm i -D @types/three`
2. **搭骨架**（`file_write`）：
   - `src/config.ts`：GDD 调参表对应的常量
   - `src/main.ts`：入口
   - Phaser 用 `new Phaser.Game({ type: Phaser.AUTO, width, height, physics: { default: 'arcade' }, scene: [Boot, Play, GameOver] })`
   - Three.js 用 `WebGLRenderer` + `PerspectiveCamera` + `requestAnimationFrame` 循环，并监听 `resize`
   - Canvas 用 `requestAnimationFrame` 固定步长更新（累加 `dt`，每步 1/60 s）
3. **先做灰盒**：用色块或几何体跑通核心循环，包括输入、碰撞、计分、失败和重开。在 `main.ts` 注册 `window.__game` 调试句柄，暴露分数和状态，方便后续自动试玩读取。
4. **生成美术素材**（`generate_image`）：
   - 按 GDD 素材清单逐个生成，提示词写明风格、视角和"纯色或透明背景"
   - 保存到 `public/assets/`
   - 生成后用 `view_image` 检查
   - 需要修改时用 `edit_image` 迭代
   - 精灵表要统一尺寸，例如 64×64
5. **生成音乐**（`generate_music`，`instrumental: true`）：
   - BGM 提示词写明风格、BPM 和"可循环"
   - 下载后放到 `public/assets/audio/`
   - 在 Phaser 中用 `this.load.audio` / `this.sound.add(key, { loop: true })` 加载
   - 浏览器要求用户交互后才能播放，所以在首次点击或按键时启动音频
6. **运行**（`shell_run`，后台）：`npm run dev -- --host 127.0.0.1 --port 5173`。然后交给 `game-playtest-ship` 技能做试玩。
7. **构建检查**（`shell_run`）：
   - 执行 `npm run build`，确保 `dist/` 生成且无 TypeScript 错误
   - 如需部署到子路径，在 `vite.config.ts` 设置 `base: './'`

## 注意事项 / 安全

- 生成的素材默认只作原型使用。告知用户商用前自行确认生成服务的授权条款。
- 不从网上抓取来源不明的精灵或音效。
- 大图压缩到合理尺寸（单张 < 500 KB），避免首屏加载过慢。

## 如何确认完成

`npm run dev` 能在浏览器打开并完整玩一局（开始 → 得分 → 失败 → 重开），并且 `npm run build` 成功。
