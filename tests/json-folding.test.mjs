import { test } from "node:test";
import assert from "node:assert/strict";
import { nestedJSONFolds } from "../src/json-folding.mjs";

test("nested folding keeps root properties visible and excludes empty values and scalars", () => {
  const text =
    '{"id":"one","address":{"city":"Tokyo","more":{"code":123}},"items":[{"id":2}],"empty":{},"other":[],"amount":9223372036854775807}';
  const ranges = nestedJSONFolds(text);
  assert.deepEqual(
    ranges.map(({ from, to }) => text.slice(from, to)),
    ['"city":"Tokyo","more":{"code":123}', '{"id":2}'],
  );
  assert(ranges.every(({ from, to }) => from > 1 && to < text.length - 1));
  for (const json of [
    "{}",
    "[]",
    "null",
    "42",
    '{"name":"flat"}',
    '{"bad":}',
    "",
  ])
    assert.deepEqual(nestedJSONFolds(json), []);
});

test("folding finds objects throughout a long document and handles a root array", () => {
  const text = JSON.stringify({
    first: { n: 1 },
    text: "x".repeat(100000),
    last: [{ n: 2 }],
  });
  assert.equal(nestedJSONFolds(text).length, 2);
  const array = '[{"id":1,"more":{"x":true}},{"id":2}]';
  assert.deepEqual(
    nestedJSONFolds(array).map(({ from, to }) => array.slice(from, to)),
    ['"id":1,"more":{"x":true}', '"id":2'],
  );
});

import { indexJSON } from "../src/json-structure.mjs";

test("JSON structure counts direct syntax children without converting numbers or duplicate keys", () => {
  const text =
    '{"a":9223372036854775807,"a":1.2300e+20,"items":[null,true,false,1,"x",{},[]]}';
  const index = indexJSON(text);
  assert.equal(index.valid, true);
  assert.deepEqual(
    index.nodes.map((n) => [n.kind, n.count, n.parent]),
    [
      ["Object", 3, -1],
      ["Array", 7, 0],
      ["Object", 0, 1],
      ["Array", 0, 1],
    ],
  );
  assert.equal(
    text.slice(index.nodes[1].from, index.nodes[1].to),
    '[null,true,false,1,"x",{},[]]',
  );
  assert.equal(indexJSON('{"bad":}').valid, false);
  assert.equal(indexJSON('"scalar"').nodes.length, 0);
});
