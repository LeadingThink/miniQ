// Run with Node's test runner; keep this outside Vitest's *.test.* discovery.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const script = readFileSync(`${__dirname}/browser_links.js`, "utf8");

function click(href, target, baseTarget = null) {
  let listener;
  let opened;
  let assigned;
  let prevented = false;
  class Element {
    closest() { return anchor; }
  }
  const anchor = {
    href,
    hasAttribute: () => false,
    getAttribute: () => target,
  };
  const window = {
    open(url, name, features) {
      opened = { url, name, features, self: this };
      return null;
    },
  };
  runInNewContext(script, {
    Element, URL, window,
    document: {
      addEventListener: (_, callback) => { listener = callback; },
      querySelector: () => baseTarget ? { getAttribute: () => baseTarget } : null,
    },
    location: { href: "https://www.bing.com/search", assign: (url) => { assigned = url; } },
  });
  // A page replacing window.open after load must not intercept our call.
  window.open = () => { throw new Error("page override was used"); };
  listener({
    button: 0, target: new Element(), defaultPrevented: false,
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => {},
  });
  return { opened, assigned, prevented, window };
}

test("target=_blank opens a new window instead of navigating the same view", () => {
  const result = click("https://www.xiaohongshu.com/explore", "_blank");
  assert.equal(result.assigned, undefined);
  assert.equal(result.prevented, true);
  assert.equal(result.opened.url, "https://www.xiaohongshu.com/explore");
  assert.equal(result.opened.name, "_blank");
  assert.equal(result.opened.self, result.window);
});
test("base target is handled", () => {
  assert.equal(click("https://example.com/", null, "_blank").opened.url, "https://example.com/");
});
test("ordinary same-view links keep native behavior", () => {
  const result = click("https://example.com/", "_self");
  assert.equal(result.prevented, false);
  assert.equal(result.opened, undefined);
});
test("unsafe protocols and embedded credentials are not redirected", () => {
  for (const href of ["javascript:alert(1)", "file:///test", "https://user:secret@example.com/"]) {
    const result = click(href, "_blank");
    assert.equal(result.opened, undefined);
    assert.equal(result.prevented, false);
  }
});
