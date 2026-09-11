import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DURATION = 55;
const FPS = 30;
const FRAMES = DURATION * FPS;
const WIDTH = 1920;
const HEIGHT = 1080;
const CHROME =
  process.env.CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/") rel = "/index.html";
      const file = join(ROOT, rel);
      if (!file.startsWith(ROOT) || !existsSync(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function startFfmpeg() {
  const out = join(ROOT, "out/video.mp4");
  const ff = spawn(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(FPS),
      "-i",
      "-",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "medium",
      "-crf",
      "16",
      "-movflags",
      "+faststart",
      out,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  return ff;
}

const { server, port } = await startServer();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    `--window-size=${WIDTH},${HEIGHT}`,
    "--hide-scrollbars",
    "--disable-lcd-text",
    "--font-render-hinting=none",
    "--disable-gpu",
  ],
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?capture=1`, {
    waitUntil: "networkidle0",
  });
  await page.waitForFunction(() => window.__ready === true, { timeout: 20000 });
  await page.evaluate((t) => window.seek(t), 0);

  const previewAt = process.env.PREVIEW
    ? [0.6, 2.2, 4.8, 7.2, 9.2, 12.0, 16.2, 19.2, 22.0, 27.0, 31.2, 35.4, 39.2, 43.2]
    : null;

  if (previewAt) {
    const { mkdir } = await import("node:fs/promises");
    const dir = join(ROOT, "out/preview");
    await mkdir(dir, { recursive: true });
    for (const t of previewAt) {
      await page.evaluate((time) => window.seek(time), t);
      const file = join(dir, `t${t.toFixed(1).replace(".", "")}.png`);
      await page.screenshot({ path: file, type: "png", captureBeyondViewport: false });
      console.log("preview", file);
    }
  } else {
    const ff = startFfmpeg();
    const t0 = Date.now();
    for (let i = 0; i < FRAMES; i++) {
      const t = i / FPS;
      await page.evaluate((time) => window.seek(time), t);
      const buf = await page.screenshot({
        type: "jpeg",
        quality: 92,
        captureBeyondViewport: false,
      });
      if (!ff.stdin.write(buf)) {
        await new Promise((r) => ff.stdin.once("drain", r));
      }
      if (i % 30 === 0 || i === FRAMES - 1) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(`  frame ${i + 1}/${FRAMES}  t=${t.toFixed(2)}s  ${elapsed}s elapsed\n`);
      }
    }
    ff.stdin.end();
    const code = await new Promise((resolve, reject) => {
      ff.on("exit", resolve);
      ff.on("error", reject);
    });
    if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
    console.log("video written  promo/out/video.mp4");
  }
} finally {
  await browser.close();
  server.close();
}
