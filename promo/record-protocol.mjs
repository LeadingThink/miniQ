import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:19400', defaultViewport: null });
const page = (await browser.pages()).find(p => p.url().includes('port=19300'));
if (!page) throw new Error('Isolated recording desktop is not open');
await page.waitForSelector('[role=dialog] select');
const original = await page.$eval('select', el => el.value);
const encoder = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '4', '-i', '-', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', 'promo/out/live/protocol.mp4'], { stdio: ['pipe', 'inherit', 'inherit'] });
const finished = once(encoder, 'exit');
try {
  const choices = ['auto', 'responses', 'anthropic_messages', 'chat_completions'];
  for (let frame = 0; frame < 56; frame++) {
    if (frame % 14 === 0) await page.select('select', choices[frame / 14]);
    const image = await page.screenshot({ type: 'jpeg', quality: 95, clip: { x: 490, y: 72, width: 460, height: 756 } });
    if (!encoder.stdin.write(image)) await once(encoder.stdin, 'drain');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
} finally {
  await page.select('select', original);
  encoder.stdin.end();
  browser.disconnect();
}
const [code] = await finished;
if (code !== 0) throw new Error(`Encoder failed: ${code}`);
console.log('Recorded four real protocol selections; original restored without saving.');
