// Reproducible local acceptance files. Contains no account or conversation data.
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = process.argv[2];
if (!output)
  throw new Error(
    "Usage: node scripts/create-preview-fixtures.mjs OUTPUT_DIRECTORY",
  );
const directory = resolve(output);
await mkdir(join(directory, "assets"), { recursive: true });
await mkdir(join(directory, "other"), { recursive: true });
await copyFile(
  new URL("../src-tauri/icons/icon.png", import.meta.url),
  join(directory, "assets/logo.png"),
);
const links = [
  "data.csv",
  "chart.svg",
  "document.docx",
  "slides.pptx",
  "document.pdf",
  "preview.html",
  "other/report.md",
];
const markdown =
  `# miniQ 原生预览验收\n\n${links.map((name) => `[${name}](${name})`).join(" · ")}\n\n## 文件与图表\n\n![本地图片](assets/logo.png)\n\n\`\`\`mermaid\nflowchart LR\n A[读取素材] --> B{质量检查}\n B -->|通过| C[完整交付]\n B -->|重试| A\n\`\`\`\n\n公式：$E=mc^2$\n\n## 完整代码\n\n\`\`\`javascript\nconst message = "${"中文长行完整保留 ".repeat(25)}";\nconsole.log(message);\n\`\`\`\n\n` +
  Array.from(
    { length: 20 },
    (_, i) =>
      `## 第 ${i + 1} 节\n\n这是检查阅读位置、目录跳转和分栏适配的段落。\n\n`,
  ).join("");
await writeFile(join(directory, "report.md"), markdown);
await writeFile(
  join(directory, "other/report.md"),
  "# 另一个同名文件\n\n标签应显示目录，避免选错。\n",
);
await writeFile(
  join(directory, "data.csv"),
  '编号,备注,金额\r\n001,"包含,逗号",123\r\n002,"保留\n换行",456\r\n' +
    Array.from({ length: 10000 }, (_, i) => `${i + 3},完整记录,${i * 7}`).join(
      "\n",
    ),
);
await writeFile(
  join(directory, "chart.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="450"><rect width="900" height="450" fill="white"/><path d="M50 350 L200 260 L350 310 L500 140 L650 190 L850 70" stroke="#12805c" stroke-width="8" fill="none"/><text x="50" y="45" font-size="28">miniQ 趋势图</text></svg>',
);
await writeFile(
  join(directory, "preview.html"),
  '<!doctype html><html lang="zh"><meta charset="utf-8"><title>交互验收</title><style>body{font:18px system-ui;margin:32px}img{width:96px}button{padding:12px}</style><h1>本地 HTML 交互验收</h1><img src="assets/logo.png" alt="本地图片"><p>计数：<output>0</output></p><button>增加</button><script>let count=0;document.querySelector("button").onclick=()=>document.querySelector("output").textContent=++count</script></html>',
);
await writeFile(
  join(directory, "image-sizing.html"),
  '<!doctype html><meta charset="utf-8"><h1>SVG 尺寸验收</h1><pre></pre><img src="chart.svg" style="max-width:300px"><script>const img=document.querySelector("img");const detached=new Image();detached.onload=()=>{document.querySelector("pre").textContent=JSON.stringify({constrained:[img.naturalWidth,img.naturalHeight],detached:[detached.naturalWidth,detached.naturalHeight]},null,2)};window.onload=()=>detached.src="chart.svg"</script>',
);
console.log(directory);
