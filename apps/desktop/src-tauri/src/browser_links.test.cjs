const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const script = readFileSync(`${__dirname}/browser_links.js`, "utf8");

function click(href, target, baseTarget = null) {
  let listener;
  let destination;
  let prevented = false;
  class Element {
    closest() { return anchor; }
  }
  const anchor = {
    href,
    hasAttribute: () => false,
    getAttribute: () => target,
  };
  runInNewContext(script, {
    Element, URL,
    document: {
      addEventListener: (_, callback) => { listener = callback; },
      querySelector: () => baseTarget ? { getAttribute: () => baseTarget } : null,
    },
    location: { href: "https://www.bing.com/search", assign: (url) => { destination = url; } },
  });
  listener({
    button: 0, target: new Element(),
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => {},
  });
  return { destination, prevented };
}

test("nested search result opens in the same view", () => {
  assert.deepEqual(click("https://www.xiaohongshu.com/explore", "_blank"), {
    destination: "https://www.xiaohongshu.com/explore", prevented: true,
  });
});
test("base target is handled", () => {
  assert.equal(click("https://example.com/", null, "_blank").destination, "https://example.com/");
});
test("ordinary same-view links keep native behavior", () => {
  assert.equal(click("https://example.com/", "_self").prevented, false);
});
test("unsafe protocols and embedded credentials are not redirected", () => {
  for (const href of ["javascript:alert(1)", "file:///test", "https://user:secret@example.com/"]) {
    assert.equal(click(href, "_blank").destination, undefined);
  }
});