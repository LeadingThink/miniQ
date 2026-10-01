# 提示词与脚本规范

## 1. 画风样张模板
```
{画风公式}. A style sample: one simple recognizable subject ({主体}) centered on a clean background, with a small palette strip and a line/shading swatch at the bottom. Readable, pretty, no text, no logos.
```
上传参考图时前缀固定写：“Match ONLY the rendering style of the reference images (line, texture, shading, palette, background treatment). Do not copy people, faces, or objects from them.”

## 2. 素材模板
- 角色（2:3）：`{画风公式}. Character sheet: {名字}, {年龄感/体型/服装/发型/标志性配饰}, full body, neutral pose, plain flat {颜色} backdrop, no text.`
- 场景（成片画幅）：`{画风公式}. Environment: {地点}, dressed with {陈设}, key anchor object: {锚点物}, no people, {光线/时间}.`
- 补拍角度：同场景 + `reverse angle` / `side angle` / `detail crop of {锚点物}`。
- 道具（1:1）：`{画风公式}. Single isolated prop: {物件}, centered, plain backdrop, no hands, no scene.`
- 穿插：纯色卡上的主体、弹出式示意图、长了脸的拟人物件。

角色身份描述（外观不变量）写一次，之后所有提示词逐字复用。

## 3. 视频块模板（每块 10 秒 = 5 个硬切镜头）
```
{画风公式}. Silent visuals, no on-screen text, no lip-sync, characters do not talk to camera.
Location: {场景}. Through-line object: {贯穿道具} ({本块状态}).
Shot 1 (0-2s): MEDIUM, eye level — {动作}.
Shot 2 (2-4s): CLOSE-UP, low angle — {动作}.
Shot 3 (4-6s): OVER-THE-SHOULDER of {角色} — {动作}.
Shot 4 (6-8s): WIDE, high angle — {动作}.
Shot 5 (8-10s): EXTREME CLOSE-UP — {动作}.
Hard cuts between shots. Keep characters identical to the reference sheets.
```
- 相邻镜头景别和角度都要不同；只有某场景的第一块可以用全景开场，之后回到该场景从近/中景或补拍角度切入。
- 过肩镜头必须有具名角色在前景；没有角色的镜头不能写过肩。
- 参考图顺序：场景 → 角色 → 道具，每块 ≤7 张。
- 不写第三方品牌、工作室、IP 名称；不承诺屏幕文字。

## 4. 脚本写作（写手规则）
1. **贯穿线**：选一个实体物件，每块都出现、状态单调升级、在收束块被回收；为它单独生成道具素材以免形变。
2. **调研**：事实类选题至少准备：开头钩子数据 1 个、3–5 个具体细节、1 个反直觉转折；保留来源 URL（绝对链接）。
3. **弧线**：钩子 → 推进（逐块升级，能随便换顺序说明写得不够）→ 反转（出人意料而非总结）→ 收束（最后一句重新解读开头钩子）。
4. **第一句**：≤8 个词（中文 ≤12 字）的冷开场，陈述句；解说/历史不打招呼不寒暄；儿童保留温暖主持人口吻。
5. **每块一个观点**，5 个镜头是这个观点的不同角度。
6. **幽默**：冷面铺垫 → 荒诞反转；巴纳姆式“说中你了”句；确认偏误梗。童话类不讲笑话。
7. **字数预算**（每个完整 10 秒块）：英文 30–34 词（儿童 34–38）；中文约 38–45 字（儿童 42–50）。短尾块按比例缩减。
8. **改写一遍再展示**：删套话、合并重复、检查每句能否在 9.8 秒内念完。
9. 旁白字段只放要念的字，不放语气括号或时间码。

## 5. script_manifest.json 结构
```json
{
  "topic": "...", "channel_type": "explainer", "style": "editorial_collage",
  "aspect": "16:9", "requested_seconds": 120,
  "through_line": {"name": "登机牌", "asset": "prop_boarding_pass", "progression": "...", "resolution": "..."},
  "arc": {"hook": "...", "build": ["..."], "turn": "...", "payoff": "..."},
  "blocks": [
    {"n": 1, "arc_role": "hook", "vo_line": "...", "location": "loc_airport",
     "through_line_state": "...", "shots": [{"size": "MEDIUM", "angle": "eye", "action": "..."}],
     "assets_used": ["loc_airport", "char_pilot", "prop_boarding_pass"]}
  ],
  "sources": ["https://..."]
}
```
用 `scripts/check_manifest.py script_manifest.json --duration-seconds 120` 校验：块数、每块镜头数、贯穿道具出现、参考 ≤7、同一场景连续 ≤2 块、旁白字数、来源为绝对 URL。退出码 1 时只改报告的问题并重跑。

## 6. 旁白语气指令（交给 narrator）
每条 TTS 调用可在文本外附语气说明，如“平稳、干脆、略带冷幽默，不拖尾音”；时间码/语气标签只在调用时临时包裹，不写回 manifest。
