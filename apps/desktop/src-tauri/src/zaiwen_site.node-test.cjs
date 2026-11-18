const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");

const script = readFileSync(`${__dirname}/zaiwen_site.js`, "utf8");
const menu = (title) => `<div class="menu flex" role="link" tabindex="0"><div class="icon-wrapper"></div><div class="title">${title}</div></div>`;
const sidebar = () => `<aside class="sidebar"><div class="scroll"><div class="menus flex-c">${["新对话", "艺术创作", "任务中心", "发现", "商用API"].map(menu).join("")}<div class="menu" role="button">生产力工具</div></div><div class="history"><button>艺术创作</button><button>发现</button></div></div></aside>`;

// Matches the main site's ProblemEntry, ChatTabbar and InputRegion structure.
const chat = (optimization = "灵感") => `
  <div class="route-page"><div class="index flex"><section class="content flex-c">
    <div class="dialogue-region"><div class="message-box"><div class="scroll"><div class="scroll-container">
      <div class="guide flex-c">
        <div class="header flex"><div class="brand-line"><h1>在问</h1></div><button class="refresh-btn">换一批</button></div>
        <div class="goal-head">今天想完成什么？</div>
        <ul class="goal-grid"><li><button>做一张封面</button></li></ul>
        <section class="continue-section">最近的生成任务和项目</section>
        <section class="my-templates">我的模板</section>
        <div class="content flex"><div class="guide-main">推荐卡片</div></div>
      </div>
      <div class="message-list"><article>艺术创作、发现、深度搜索和 agent 是什么意思？</article></div>
    </div></div><button aria-label="回到最新消息">↓</button></div></div>
    <div class="func-region"><div class="chat-tabbar">
      ${["智能体", "视频生成", "呐响音乐", "随心作画", "思维导图", "知识库", "AI·PPT", "文件分析"].map((title) => `<button>${title}</button>`).join("")}
    </div></div>
    <div class="input-region"><div class="input-box">
      <div class="draft-warning">草稿保存提示</div>
      <div class="plugin"><span class="attachment">问题.txt</span></div>
      <div class="intent-chip"><button>切换到视频生成</button></div>
      <div class="text-box"><textarea aria-label="聊天输入框">保留当前草稿</textarea></div>
      <div class="input-bottom-bar flex-w"><div class="left flex-w">
        <button class="select-model" aria-label="选择模型">zaiwen-auto</button>
        <div role="button" data-testid="online-toggle" tabindex="0">自动联网</div>
        <div role="button" data-testid="deep-search-toggle" tabindex="0">深度搜索</div>
        <div role="button" data-testid="agent-toggle" tabindex="0">agent</div>
      </div><div class="right flex">
        <button class="tooltip-trigger icon-button" aria-label="偏好设置">设置</button>
        <span class="tooltip-trigger"><button class="h-optimize">${optimization}</button></span>
        <button class="tooltip-trigger icon-button" aria-label="上传文件">上传</button>
        <input type="file" hidden multiple />
        <button aria-label="语音输入">语音</button>
        <button class="tooltip-trigger icon-button" aria-label="发送">发送</button>
      </div></div>
      <button class="clear-context" aria-label="清空上下文">清空</button>
    </div><footer>AI 内容提示</footer></div>
  </section></div></div>`;

function visible(window, selector) {
  const element = window.document.querySelector(selector);
  assert.ok(element, `missing element: ${selector}`);
  for (let item = element; item; item = item.parentElement) {
    if (window.getComputedStyle(item).display === "none") return false;
  }
  return true;
}

function page(t, url = "https://chat.zaiwenai.com/") {
  const dom = new JSDOM("", { url, runScripts: "outside-only" });
  const observers = [];
  const NativeObserver = dom.window.MutationObserver;
  dom.window.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  t.after(() => {
    observers.forEach((observer) => observer.disconnect());
    dom.window.close();
  });
  dom.window.eval(script);
  return dom.window;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const navItems = (document) => [...document.querySelectorAll('.menus > .menu[role="link"]')];
const visibleTitles = (window) => navItems(window.document)
  .filter((item) => window.getComputedStyle(item).display !== "none")
  .map((item) => item.querySelector(".title").textContent);

test("hides only the two navigation entries while keeping chat, history and content", async (t) => {
  const window = page(t);
  window.document.body.innerHTML = `${sidebar()}<main>${menu("发现")}<p>艺术创作与发现</p><textarea>聊天草稿</textarea></main>`;
  await flush();
  assert.deepEqual(visibleTitles(window), ["新对话", "任务中心", "商用API"]);
  assert.equal(window.document.querySelectorAll("[data-miniq-hidden-navigation]").length, 2);
  for (const item of window.document.querySelectorAll(".history button, main .menu, main p, textarea")) {
    assert.notEqual(window.getComputedStyle(item).display, "none");
  }
  assert.equal(window.document.querySelector("textarea").value, "聊天草稿");
});

test("handles desktop/mobile sidebars recreated after client-side navigation", async (t) => {
  const window = page(t);
  for (const path of ["/", "/?conversation_id=123"]) {
    window.history.pushState({}, "", path);
    window.document.body.innerHTML = sidebar() + sidebar().replace('class="sidebar"', 'class="sidebar sidebar-mobile"');
    await flush();
    assert.equal(window.document.querySelectorAll("[data-miniq-hidden-navigation]").length, 4);
    assert.deepEqual(visibleTitles(window), ["新对话", "任务中心", "商用API", "新对话", "任务中心", "商用API"]);
  }
});

test("updates visibility when Vue reuses a menu node and changes its title", async (t) => {
  const window = page(t);
  window.document.body.innerHTML = sidebar();
  await flush();
  const item = navItems(window.document)[1];
  item.querySelector(".title").firstChild.data = "新对话";
  await flush();
  assert.notEqual(window.getComputedStyle(item).display, "none");
  item.querySelector(".title").textContent = "发现";
  await flush();
  assert.equal(window.getComputedStyle(item).display, "none");
});

test("installs once and reapplies to a newly loaded document", async (t) => {
  for (let i = 0; i < 2; i++) {
    const window = page(t);
    window.document.body.innerHTML = sidebar();
    window.eval(script);
    await flush();
    assert.equal(window.document.querySelectorAll("#miniq-zaiwen-chat-style").length, 1);
    assert.equal(window.document.querySelectorAll("[data-miniq-hidden-navigation]").length, 2);
  }
});

test("leaves authentication providers and other origins untouched", async (t) => {
  for (const url of ["https://example.com/", "https://chat.zaiwenai.com.example.com/", "http://chat.zaiwenai.com/"]) {
    const window = page(t, url);
    window.document.body.innerHTML = sidebar() + chat();
    await flush();
    assert.equal(window.document.querySelectorAll("[data-miniq-hidden-navigation]").length, 0);
    assert.equal(window.document.querySelector("#miniq-zaiwen-chat-style"), null);
    assert.equal(visible(window, ".goal-grid"), true);
    assert.equal(visible(window, ".func-region"), true);
  }
});

test("does not alter embedded documents inside the site", async (t) => {
  const window = page(t);
  const frame = window.document.createElement("iframe");
  frame.src = "https://chat.zaiwenai.com/";
  window.document.body.appendChild(frame);
  frame.contentDocument.write(`<html><head></head><body>${sidebar()}${chat()}</body></html>`);
  frame.contentDocument.close();
  frame.contentWindow.eval(script);
  await flush();
  assert.equal(frame.contentDocument.querySelectorAll("[data-miniq-hidden-navigation]").length, 0);
  assert.equal(visible(frame.contentWindow, ".goal-grid"), true);
});

test("keeps the basic chat composer and messages while hiding recommendations and creative tools", async (t) => {
  const window = page(t);
  window.document.body.innerHTML = sidebar() + chat();
  await flush();
  for (const selector of [
    ".refresh-btn", ".goal-head", ".goal-grid", ".continue-section", ".my-templates", ".guide-main",
    ".func-region", ".intent-chip", '[data-testid="deep-search-toggle"]', '[data-testid="agent-toggle"]', ".h-optimize",
  ]) assert.equal(visible(window, selector), false, selector);
  for (const selector of [
    ".brand-line", ".message-list article", ".draft-warning", ".attachment", "textarea", ".select-model",
    '[data-testid="online-toggle"]', '[aria-label="偏好设置"]', '[aria-label="上传文件"]',
    '[aria-label="语音输入"]', '[aria-label="发送"]', ".clear-context", '[aria-label="回到最新消息"]', "footer",
  ]) assert.equal(visible(window, selector), true, selector);

  const input = window.document.querySelector("textarea");
  assert.equal(input.value, "保留当前草稿");
  const sent = [];
  window.document.querySelector('[aria-label="发送"]').addEventListener("click", () => sent.push(input.value));
  input.value = "艺术创作与发现是什么？";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[aria-label="发送"]').click();
  assert.deepEqual(sent, ["艺术创作与发现是什么？"]);
});

test("keeps the simplified layout after page replacement and while a reply is streaming", async (t) => {
  const window = page(t);
  for (const title of ["灵感", "优化"]) {
    window.history.pushState({}, "", "/?conversation_id=123");
    window.document.body.innerHTML = chat(title);
    const send = window.document.querySelector('[aria-label="发送"]');
    send.setAttribute("aria-label", "停止生成");
    send.textContent = "停止生成";
    await flush();
    assert.equal(visible(window, ".h-optimize"), false);
    assert.equal(visible(window, ".func-region"), false);
    assert.equal(visible(window, '[aria-label="停止生成"]'), true);
    assert.equal(visible(window, ".message-list article"), true);
    assert.equal(window.document.querySelector("textarea").value, "保留当前草稿");
  }
});

test("does not hide similarly named content in messages or other site pages", async (t) => {
  const window = page(t);
  window.document.body.innerHTML = chat();
  const content = '<div class="guide"><div class="goal-grid">正文示例</div></div><div class="func-region">正文工具栏示例</div>';
  window.document.querySelector("article").innerHTML = content;
  window.document.body.insertAdjacentHTML("beforeend", `<div id="settings" class="route-page"><div class="index"><section class="content"><div class="input-region"><div class="input-box"><div class="intent-chip">设置示例</div></div></div>${content}</section></div></div>`);
  await flush();
  for (const selector of ["article .goal-grid", "article .func-region", "#settings .goal-grid", "#settings .func-region", "#settings .intent-chip"]) {
    assert.equal(visible(window, selector), true, selector);
  }
});
