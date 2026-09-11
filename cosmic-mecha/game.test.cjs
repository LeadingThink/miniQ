const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

function setup() {
  class Element {
    constructor() {
      this.children = [];
      this.attributes = {};
      this.classList = { toggle() {} };
    }
    set innerHTML(value) {
      this.children = [];
      this.html = value;
    }
    setAttribute(key, value) {
      this.attributes[key] = value;
    }
    append(...children) {
      this.children.push(...children);
    }
    prepend(...children) {
      this.children.unshift(...children);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    focus() {
      document.activeElement = this;
    }
    close() {
      this.open = false;
    }
    showModal() {
      this.open = true;
    }
  }
  const elements = new Map();
  const document = {
    activeElement: null,
    dispatchEvent() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() {
      return new Element();
    },
    createTextNode(text) {
      return text;
    },
  };
  vm.runInNewContext(readFileSync(`${__dirname}/game.js`, "utf8"), {
    document,
    confirm: () => true,
    CustomEvent: class {},
  });
  const get = (id) => document.getElementById(id);
  const select = (coord) => {
    const cell = get("board").children.find((c) =>
      c.attributes["aria-label"].startsWith(`${coord} `)
    );
    assert.ok(cell, coord);
    cell.onclick();
  };
  const click = (id) => {
    assert.equal(get(id).disabled, false, `${id} should be enabled`);
    get(id).onclick();
  };
  return { get, select, click, document };
}

test("initial board, movement limits and range validation", () => {
  const { get, select, click } = setup();
  assert.equal(get("board").children.length, 48);
  assert.equal(get("hp").textContent, "100 / 100");
  select("A1");
  assert.equal(get("move").disabled, true);
  select("B1");
  assert.equal(get("fire").disabled, true);
  select("C6");
  assert.equal(get("move").disabled, true);
  select("C4");
  click("move");
  assert.equal(get("position").textContent, "坐标 C4");
  assert.equal(get("turn").textContent, "回合 02");
});

test("documented route wins and restart restores the mission", () => {
  const { get, select, click } = setup();
  select("C4");
  click("move");
  select("C1");
  click("fire");
  select("F3");
  click("fire");
  select("C1");
  click("fire");
  click("guard");
  select("C1");
  click("fire");
  click("guard");
  const last = get("board").children.find((c) =>
    c.attributes["aria-label"].includes("赤隼")
  );
  last.onclick();
  click("fire");
  assert.equal(get("kills").textContent, "04 / 04");
  assert.equal(get("result").open, true);
  assert.equal(get("result-title").textContent, "星海仍然明亮。");
  assert.equal(get("guard").disabled, true);
  get("again").onclick();
  assert.equal(get("result").open, false);
  assert.equal(get("hp").textContent, "100 / 100");
  assert.equal(get("kills").textContent, "00 / 04");
});

test("guard caps energy and eventually leads to defeat without attacking", () => {
  const { get, click } = setup();
  click("guard");
  assert.equal(get("energy").textContent, "100 / 100");
  for (let i = 0; i < 100 && !get("result").open; i++) click("guard");
  assert.equal(get("hp").textContent, "0 / 100");
  assert.equal(get("result-title").textContent, "信号中断，驾驶员已弹出。");
  assert.ok(
    get("log").children.length > 30,
    "the complete combat log must be retained"
  );
  assert.ok(get("log").children.at(-1).children[1].includes("咖啡可以凉"));
});

test("keyboard focus survives selection and arrows move the board cursor", () => {
  const { get, select, document } = setup();
  select("C4");
  assert.match(document.activeElement.attributes["aria-label"], /^C4 /);
  let prevented = false;
  document.activeElement.onkeydown({
    key: "ArrowRight",
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.match(document.activeElement.attributes["aria-label"], /^D4 /);
  assert.equal(
    get("board").children.filter((cell) => cell.tabIndex === 0).length,
    1
  );
  document.activeElement.onclick();
  assert.equal(get("target").textContent, "LOCK D4");
  assert.match(document.activeElement.attributes["aria-label"], /^D4 /);
});

test("insufficient energy blocks a shot without consuming a turn", () => {
  const { get, select, click } = setup();
  select("C4");
  click("move");
  select("C1");
  click("fire");
  select("F3");
  click("fire");
  select("C1");
  click("fire");
  select("C1");
  assert.equal(get("energy").textContent, "10 / 100");
  assert.equal(get("fire").disabled, true);
  const turn = get("turn").textContent;
  get("fire").onclick();
  assert.equal(get("turn").textContent, turn);
  assert.equal(get("energy").textContent, "10 / 100");
});
