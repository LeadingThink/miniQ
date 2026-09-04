import test from "node:test";
import assert from "node:assert/strict";
import { definePlugin, PluginError } from "../dist/index.js";

test("definePlugin preserves a valid typed definition", () => {
  const plugin = definePlugin({ id: "dev.miniq.test", version: "1.0.0", activate() {} });
  assert.equal(plugin.id, "dev.miniq.test");
  assert.ok(Object.isFrozen(plugin));
});

test("definePlugin rejects incomplete definitions", () => {
  assert.throws(() => definePlugin({}), PluginError);
});
