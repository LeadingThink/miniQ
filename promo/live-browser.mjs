import puppeteer from 'puppeteer-core';
import { readFile, mkdir } from 'node:fs/promises';

const mode = process.argv[2] ?? 'start';
if (mode === 'start') {
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--remote-debugging-port=19400'], defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 } });
  const desktop = await browser.newPage();
  await desktop.goto('http://127.0.0.1:1420/?port=19300&token=promo-local-recording');
  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 430, height: 900, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  // Route the production relay endpoint to an isolated instance of the same relay implementation.
  await mobile.evaluateOnNewDocument(() => {
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url, protocols) { super(String(url).includes('miniq-relay/ws') ? 'ws://127.0.0.1:19200/ws' : url, protocols); }
    };
  });
  await mobile.goto('http://127.0.0.1:1420/');
  console.log('Recording browser ready on 19400');
} else {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:19400', defaultViewport: null });
  const pages = await browser.pages();
  const desktop = pages.find(p => p.url().includes('port=19300'));
  const mobile = pages.find(p => p.url() === 'http://127.0.0.1:1420/');
  const click = async (page, text) => page.evaluate(text => {
    const el = [...document.querySelectorAll('button')].find(e => e.innerText.trim() === text || e.getAttribute('aria-label') === text || e.title === text);
    if (!el) throw new Error(`Button not found: ${text}`);
    el.click();
  }, text);
  const snapshot = async page => page.evaluate(() => ({ text: document.body.innerText, inputs: [...document.querySelectorAll('input,textarea,select')].map(e => ({ tag: e.tagName, type: e.type, placeholder: e.getAttribute('placeholder'), aria: e.getAttribute('aria-label') })), buttons: [...document.querySelectorAll('button')].map(e => ({text:e.innerText, aria:e.getAttribute('aria-label'), title:e.title})) }));
  const key = async () => { const s = JSON.parse(await readFile(`${process.env.HOME}/.local/share/miniq/settings.json`, 'utf8')); return s.provider.apiKey ?? s.provider.api_key; };
  await mkdir(new URL('out/live/', import.meta.url), { recursive: true });
  try { await eval(`(async () => { ${process.argv[3] ?? 'console.log(JSON.stringify(await snapshot(desktop)))'} })()`); }
  finally { browser.disconnect(); }
}
