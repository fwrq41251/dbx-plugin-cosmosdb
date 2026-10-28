import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonResultItems, jsonResultItemAt } from "../src/result-items.mjs";
import { parseJSON } from "../src/model.mjs";

test("nested fields, arrays and escaped strings resolve to their own top-level item", () => {
  const text =
    '[\n {"id":"one","nested":{"id":"inner","values":[{"x":"[,] {} \\\"quoted\\\""}]}},\n {"id":"two","tenant":9223372036854775807},null,"hello",[1,2]]';
  const items = jsonResultItems(text);
  assert.equal(items.length, 5);
  assert.equal(jsonResultItemAt(items, text.indexOf("inner")).index, 0);
  assert.equal(jsonResultItemAt(items, text.indexOf("quoted")).index, 0);
  const second = jsonResultItemAt(items, text.indexOf("9223372036854775807"));
  assert.equal(second.index, 1);
  const json = text.slice(second.from, second.to);
  assert.equal(parseJSON(json).id, "two");
  assert.match(json, /9223372036854775807/);
  assert.equal(text.slice(items[2].from, items[2].to), "null");
  assert.equal(text.slice(items[3].from, items[3].to), '"hello"');
  assert.equal(text.slice(items[4].from, items[4].to), "[1,2]");
});

test("array punctuation, whitespace, invalid text and out-of-range positions are not items", () => {
  const text = '[  {"id":"one"},  42 ]';
  const items = jsonResultItems(text);
  for (const pos of [-1, 0, 1, items[0].to, items[1].to, text.length, NaN, 1.5])
    assert.equal(jsonResultItemAt(items, pos), null);
  assert.equal(jsonResultItemAt(items, items[0].from), items[0]);
  assert.equal(jsonResultItemAt(items, items[0].to - 1), items[0]);
  for (const invalid of [
    "",
    "[]",
    "{}",
    '"[]"',
    '[{"x":[}]}]',
    "[1,]",
    "[1] [2]",
  ])
    assert.deepEqual(jsonResultItems(invalid), []);
});

test("index covers items beyond a viewport and does not confuse nested entries with root items", () => {
  const text = JSON.stringify([
    { id: "one", items: Array.from({ length: 1000 }, (_, i) => ({ i })) },
    { id: "last" },
  ]);
  const items = jsonResultItems(text);
  assert.equal(items.length, 2);
  assert.equal(jsonResultItemAt(items, text.indexOf('"i":999')).index, 0);
  assert.equal(jsonResultItemAt(items, text.indexOf('"last"')).index, 1);
});
