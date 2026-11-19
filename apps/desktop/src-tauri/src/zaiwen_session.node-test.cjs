const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { strict: assert } = require("node:assert");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const script = readFileSync(join(__dirname, "zaiwen_session.js"), "utf8");

test("reads a completed SPA login without reloading, and observes logout", () => {
  const dom = new JSDOM("", { url: "https://chat.zaiwenai.com/", runScripts: "outside-only" });
  try {
    assert.equal(JSON.parse(dom.window.eval(script)), null);
    dom.window.localStorage.setItem("token", "main-session-fixture");
    assert.equal(JSON.parse(dom.window.eval(script)), "main-session-fixture");
    dom.window.localStorage.removeItem("token");
    assert.equal(JSON.parse(dom.window.eval(script)), null);
  } finally { dom.window.close(); }
});

test("never reads storage on redirects, HTTP, similar domains, or other origins", () => {
  for (const url of ["https://platform.zaiwenai.com/", "https://evil.test/", "http://chat.zaiwenai.com/", "https://chat.zaiwenai.com.evil.test/"]) {
    const dom = new JSDOM("", { url, runScripts: "outside-only" });
    try {
      Object.defineProperty(dom.window, "localStorage", { get() { throw new Error("must not read storage"); } });
      assert.equal(JSON.parse(dom.window.eval(script)), null);
    } finally { dom.window.close(); }
  }
});

test("does not read session storage in a same-origin iframe", () => {
  const dom = new JSDOM('<iframe src="https://chat.zaiwenai.com/"></iframe>', { url: "https://chat.zaiwenai.com/", runScripts: "outside-only" });
  try {
    const frame = dom.window.document.querySelector("iframe").contentWindow;
    Object.defineProperty(frame, "localStorage", { get() { throw new Error("must not read child storage"); } });
    assert.equal(JSON.parse(frame.eval(script)), null);
  } finally { dom.window.close(); }
});
