import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJSON } from "../src/model.mjs";
import {
  KnownFields,
  sqlCompletions,
  hasRootProjection,
} from "../src/sql-completion.mjs";
const complete = (text, options) =>
  sqlCompletions(
    text,
    text.indexOf("|") < 0 ? text.length : text.indexOf("|"),
    options,
  );
const fields = new KnownFields();
fields.learn(
  parseJSON(
    '{"id":"one","address":{"city":"Tokyo"},"items":[{"price":1}],"first name":"x","number":9223372036854775807}',
  ),
);
test("Cosmos keywords, functions and parameters without remote metadata", () => {
  assert(complete("SEL").options.some((x) => x.label === "SELECT"));
  assert(
    complete("SELECT * FROM c WHERE IS_DEF").options.some(
      (x) => x.label === "IS_DEFINED",
    ),
  );
  assert.deepEqual(
    complete("SELECT * FROM c WHERE c.id = @m", {
      parameters: ["@member", "@id", "@member"],
    }).options.map((x) => x.label),
    ["@member"],
  );
});
test("fields resolve root aliases, nested paths, arrays and bracket access", () => {
  assert(
    complete("SELECT * FROM doc WHERE doc.", { fields }).options.some(
      (x) => x.label === ".id",
    ),
  );
  assert.equal(
    complete("SELECT * FROM c WHERE c.address.c", { fields }).options[0].apply,
    ".city",
  );
  assert.equal(
    complete("SELECT * FROM c JOIN item IN c.items WHERE item.p", { fields })
      .options[0].apply,
    ".price",
  );
  assert.equal(
    complete("SELECT * FROM c WHERE c.f", { fields }).options[0].apply,
    '["first name"]',
  );
  assert.equal(complete("SELECT * FROM c WHERE unknown.", { fields }), null);
  assert.deepEqual(fields.children(["number"]), []);
});
test("quoted strings/comments cannot trigger completion or invent aliases", () => {
  for (const sql of [
    'SELECT * FROM c WHERE c.id = "c.',
    "SELECT * FROM c -- c.",
    "SELECT * FROM c /* c.",
  ])
    assert.equal(complete(sql, { fields }), null);
  assert.equal(complete('SELECT "FROM fake" WHERE fake.', { fields }), null);
  assert(
    complete("SELECT * FROM c /* done */ WHERE c.", { fields }).options.length >
      0,
  );
});
test("only root projections can be used as document field evidence; caches are isolated and bounded", () => {
  assert(hasRootProjection("SELECT * FROM c"));
  assert(hasRootProjection("SELECT TOP 10 * FROM c WHERE c.id = @id"));
  for (const sql of [
    "SELECT c.id AS other FROM c",
    "SELECT VALUE c FROM c",
    "SELECT * FROM c JOIN x IN c.items",
    "SELECT * FROM (SELECT VALUE c FROM c)",
  ])
    assert(!hasRootProjection(sql));
  const other = new KnownFields();
  assert.equal(other.children([]).length, 0);
  other.learn(
    Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [String(i), i])),
  );
  assert.equal(other.count, 2000);
});

import { sqlParameterNames } from "../src/sql-completion.mjs";
test("parameter visibility recognizes real placeholders while ignoring comments and strings", () => {
  assert.deepEqual(
    sqlParameterNames(`SELECT * FROM c WHERE c.id=@id AND c.n=@数 AND c.x=@id -- @comment
    /* @block */ AND c.email="a@b" AND c.s='@quoted'`),
    ["@id", "@数"],
  );
});
