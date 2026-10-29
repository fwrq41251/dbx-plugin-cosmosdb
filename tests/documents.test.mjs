import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJSON, encodeJSON } from "../src/model.mjs";
import {
  newDocument,
  applyDocumentPartition,
  prepareDocument,
  documentChanges,
} from "../src/documents.mjs";

test("drafts inherit typed and hierarchical partition fields with safe pointer decoding", () => {
  const doc = newDocument(
    ["/tenant", "/a~1b/~0n"],
    '["demo",9223372036854775807]',
    "uuid",
  );
  assert.equal(doc.tenant, "demo");
  assert.match(encodeJSON(doc), /9223372036854775807/);
  assert.ok(doc["a/b"]["~n"]);
  applyDocumentPartition(doc, "[{},null]", ["/tenant", "/n"]);
  assert.equal(Object.hasOwn(doc, "tenant"), false);
  assert.equal(doc.n, null);
  const safe = newDocument(["/__proto__/polluted"], "[true]", "safe");
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(safe, "__proto__"), true);
});
test("writes strip only top-level system fields and reject partition or identity changes", () => {
  const text =
    '{"id":"one","tenant":"demo","amount":9223372036854775807,"_etag":"old","nested":{"_ts":12}}';
  const result = prepareDocument(text, '["demo"]', ["/tenant"], {
    id: "one",
    partitionKeyText: '["demo"]',
  });
  assert.match(result.text, /9223372036854775807/);
  assert.ok(!Object.hasOwn(result.doc, "_etag"));
  assert.ok(Object.hasOwn(result.doc.nested, "_ts"));
  assert.throws(
    () => prepareDocument(text, '["other"]', ["/tenant"]),
    /不一致/,
  );
  assert.throws(
    () =>
      prepareDocument(text, '["demo"]', ["/tenant"], {
        id: "other",
        partitionKeyText: '["demo"]',
      }),
    /不能更改/,
  );
});
test("diffs distinguish missing, null, types, arrays, precise numbers and escaped paths", () => {
  const before = parseJSON(
    '{"id":"one","_etag":"old","n":9223372036854775807,"a/b":{"~x":null},"list":[1],"old":true}',
  );
  const after = parseJSON(
    '{"id":"one","_etag":"new","n":9223372036854775808,"a/b":{"~x":"null"},"list":[1,2],"added":null}',
  );
  const changes = documentChanges(before, after);
  assert.equal(changes.length, 5);
  assert.deepEqual(
    changes.find((x) => x.path === "/n"),
    {
      kind: "replace",
      path: "/n",
      before: "9223372036854775807",
      after: "9223372036854775808",
    },
  );
  assert.ok(changes.some((x) => x.path === "/a~1b/~0x"));
  assert.equal(changes.find((x) => x.path === "/added").before, "（不存在）");
  assert.equal(changes.find((x) => x.path === "/old").after, "（删除）");
  assert.equal(
    documentChanges(before, { ...before, _etag: "another" }).length,
    0,
  );
});
