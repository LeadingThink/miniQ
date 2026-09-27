# 打印与分页

## 常用打印 CSS
```css
@page { size: A4; margin: 12mm; }
@media print {
  body { font-size: 10.5pt; line-height: 1.5; }
  nav.toc, .no-print { display: none; }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  figure, img, table, .kpi-card, .chart { break-inside: avoid; page-break-inside: avoid; }
  thead { display: table-header-group; }   /* 长表格续页重复表头 */
  tr { break-inside: avoid; }
  a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 8pt; color: #666; }
  .page-break { break-before: page; page-break-before: always; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
```

## 常见问题
| 现象 | 处理 |
|---|---|
| 背景色/卡片颜色丢失 | 加 `print-color-adjust: exact` |
| 表格被截断在右侧 | 横版 `--landscape`；或减小字号、允许换行 `word-break: break-all` |
| 图片被切成两半 | `break-inside: avoid`；图片 `max-width:100%` |
| 标题在页底孤立 | `break-after: avoid` |
| 中文方块 | `font-family` 加 "PingFang SC","Microsoft YaHei","Noto Sans CJK SC" |
| 交互图表空白 | 打印前 JS 未执行完：引擎需等待渲染；或改用静态 SVG/PNG |
| 暗色主题费墨 | `@media print` 中切换为浅色 |

## 纸张建议
- 文字报告：A4 纵向
- 看板快照、宽表：A4 横向（脚本仅支持 A4/Letter；需要更大幅面时缩小边距或拆页）
- 北美读者：Letter

## 手动打印（无引擎时）
浏览器打开 HTML → 打印（Cmd/Ctrl+P）→ 目标选“另存为 PDF” → 勾选“背景图形” → 边距“默认” → 保存。
