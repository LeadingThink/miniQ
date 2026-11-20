import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const ios = read("ios/App/App/MiniqZaiwenPlugin.swift");
const android = read("android/app/src/main/java/com/leadingthink/miniq/MiniqZaiwenPlugin.java");

test("both native bridges implement the same limited site navigation contract", () => {
  const methods = ["goBack", "getState", "reload", "update"].sort();
  assert.deepEqual([...ios.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((match) => match[1]).sort(), methods);
  assert.deepEqual([...android.matchAll(/@PluginMethod public void (\w+)\(/g)].map((match) => match[1]).sort(), methods);
  assert.doesNotMatch(ios, /addScriptMessageHandler|registerPlugin|CAPBridgeViewController/);
  assert.doesNotMatch(android, /addJavascriptInterface|BridgeWebViewClient|loadDataWithBaseURL/);
});

test("native mobile bridges mark the shared site view and keep compact navigation", () => {
  assert.match(android, /window\.__MINIQ_MOBILE_SITE__\s*=\s*true/);
  assert.match(ios, /window\.__MINIQ_MOBILE_SITE__\s*=\s*true/);
  assert.match(read("src-tauri/src/zaiwen_site.js"), /new Set\(\["任务中心", "商用API", "生产力工具"\]\)/);
});

test("native entry points register the plugin and the iOS build target includes its sources", () => {
  assert.match(read("ios/App/App/MainViewController.swift"), /registerPluginInstance\(MiniqZaiwenPlugin\(\)\)/);
  assert.match(read("android/app/src/main/java/com/leadingthink/miniq/MainActivity.java"), /registerPlugin\(MiniqZaiwenPlugin.class\)/);
  const project = read("ios/App/App.xcodeproj/project.pbxproj");
  const sources = project.split("/* Begin PBXSourcesBuildPhase section */")[1];
  for (const file of ["MiniqZaiwenPlugin.swift", "MiniqZaiwenPolicy.swift"]) {
    assert.match(sources, new RegExp(`${file.replaceAll(".", "\\.")} in Sources`));
  }
  assert.match(read("capacitor.config.ts"), /disableBackButtonHandler:\s*false/);
});

test("the real Vite configuration packages the shared script at the native resource path", async () => {
  assert.match(ios, /forResource: "zaiwen_site", withExtension: "js", subdirectory: "public"/);
  assert.match(android, /loadScript\("zaiwen_site"\)/);
  assert.match(android, /loadScript\("zaiwen_mobile"\)/);
  const script = read("src-tauri/src/zaiwen_site.js");
  assert.match(script, /window.top !== window/);
  assert.match(script, /location.origin !== "https:\/\/chat.zaiwenai.com"/);
  const temp = mkdtempSync(resolve(tmpdir(), "miniq-zaiwen-assets-"));
  try {
    const { build } = await import("vite");
    const input = resolve(temp, "entry.js");
    writeFileSync(input, "export {};\n");
    await build({ root, configFile: resolve(root, "vite.config.ts"), publicDir: false, logLevel: "silent",
      build: { outDir: resolve(temp, "dist"), rollupOptions: { input } } });
    assert.equal(readFileSync(resolve(temp, "dist/zaiwen_site.js"), "utf8"), script);
    assert.equal(readFileSync(resolve(temp, "dist/zaiwen_mobile.js"), "utf8"), read("src/mobile/zaiwen_mobile.js"));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("iOS navigation policy allows HTTPS authentication and blocks unsafe schemes", { skip: process.platform !== "darwin" }, () => {
  const temp = mkdtempSync(resolve(tmpdir(), "miniq-zaiwen-policy-"));
  try {
    const executable = resolve(temp, "policy-tests");
    execFileSync("swiftc", ["-module-cache-path", resolve(temp, "cache"),
      resolve(root, "ios/App/App/MiniqZaiwenPolicy.swift"),
      resolve(root, "ios/App/Tests/MiniqZaiwenPolicyTests.swift"), "-o", executable], { timeout: 45000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5000 }), /14 iOS navigation policy cases passed/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("mobile site switch uses the existing header and preserves sidebar and account controls", async () => {
  const dom = new JSDOM('<div class="layout"><main class="main"><nav class="header"><div class="mobile-nav-group"><button class="mobile-menu-btn">导航</button><strong>高效问答</strong></div><button id="login">登录</button></nav></main></div>', {
    url: "https://chat.zaiwenai.com/", runScripts: "outside-only",
  });
  const observers = [];
  const Observer = dom.window.MutationObserver;
  dom.window.MutationObserver = class extends Observer {
    constructor(callback) { super(callback); observers.push(this); }
  };
  try {
    const script = read("src/mobile/zaiwen_mobile.js");
    dom.window.eval(script);
    dom.window.eval(script);
    await new Promise(resolve => setTimeout(resolve, 0));
    const document = dom.window.document;
    const button = document.querySelector("#miniq-mobile-platform-switch");
    assert.equal(button.parentElement, document.querySelector(".mobile-nav-group"));
    assert.equal(button.nextElementSibling.className, "mobile-menu-btn");
    assert.equal(button.href, "miniq-platform://menu");
    button.click();
    const menu = document.querySelector("#miniq-mobile-platform-switch-menu");
    assert.equal(menu?.getAttribute("role"), "menu");
    assert.equal(menu?.hidden, false);
    assert.equal(menu?.querySelector('a[href="miniq-platform://switch/miniq"]')?.textContent, "miniQ构建、调试和发布");
    assert.equal(document.querySelectorAll("nav.header").length, 1);
    assert.equal(document.querySelectorAll("#miniq-mobile-platform-switch").length, 1);
    assert.equal(document.querySelector("#login").textContent, "登录");
    assert.equal(dom.window.getComputedStyle(document.querySelector("strong")).display, "none");
    const replacement = document.querySelector(".mobile-nav-group").cloneNode(true);
    replacement.querySelector("a").remove();
    document.querySelector(".mobile-nav-group").replaceWith(replacement);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelectorAll("#miniq-mobile-platform-switch").length, 1);
  } finally { observers.forEach(observer => observer.disconnect()); dom.window.close(); }
});

test("mobile navigation adaptation does not run on authentication or untrusted origins", () => {
  for (const url of ["https://accounts.example.com/", "https://chat.zaiwenai.com.evil.test/"]) {
    const dom = new JSDOM('<div class="mobile-nav-group"></div>', { url, runScripts: "outside-only" });
    try {
      dom.window.eval(read("src/mobile/zaiwen_mobile.js"));
      assert.equal(dom.window.document.querySelector("#miniq-mobile-platform-switch"), null);
      assert.equal(dom.window.document.querySelector("style"), null);
    } finally { dom.window.close(); }
  }
});
