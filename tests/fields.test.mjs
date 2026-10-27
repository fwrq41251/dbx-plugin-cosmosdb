import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJSON, encodeJSON } from "../src/model.mjs";
import {
  documentFields,
  parseFieldInput,
  editDocumentField,
  buildDocumentPatch,
  protectedField,
  documentPathExists,
} from "../src/fields.mjs";

test("field editing preserves scalar types, nested values and exact numeric text", () => {
  const doc = parseJSON(
    '{"id":"one","scope":{"tenant":"demo","count":9223372036854775807},"enabled":true,"list":[1,2],"_etag":"hidden"}',
  );
  const rows = documentFields(doc, ["/scope/tenant"]);
  assert.equal(rows.find((x) => x.path === "/id").locked, true);
  assert.equal(rows.find((x) => x.path === "/scope/tenant").locked, true);
  assert.equal(rows.find((x) => x.path === "/list").kind, "json");
  assert.ok(!rows.some((x) => x.path === "/_etag"));
  const edited = editDocumentField(
    doc,
    "/scope/count",
    parseFieldInput("9223372036854775808", "number"),
    ["/scope/tenant"],
  );
  assert.match(encodeJSON(edited), /9223372036854775808/);
  assert.match(encodeJSON(doc), /9223372036854775807/);
  assert.throws(() => parseFieldInput("1e", "number"));
  assert.throws(() => parseFieldInput('"12"', "number"));
  assert.equal(parseFieldInput("false", "boolean"), false);
  assert.equal(parseFieldInput("null", "string"), "null");
});
test("patches contain only changed properties; arrays stay atomic and pointer escapes are correct", () => {
  const before = parseJSON(
    '{"id":"one","tenant":"demo","nested":{"a/b":1,"remove":true},"list":[1,2],"keep":"unchanged"}',
  );
  const after = parseJSON(
    '{"id":"one","tenant":"demo","nested":{"a/b":2},"list":[1,3],"keep":"unchanged","new":null}',
  );
  const ops = buildDocumentPatch(before, after, ["/tenant"]);
  assert.deepEqual(
    ops.map((x) => [x.op, x.path]),
    [
      ["set", "/nested/a~1b"],
      ["remove", "/nested/remove"],
      ["set", "/list"],
      ["set", "/new"],
    ],
  );
  assert.ok(!encodeJSON(ops).includes("unchanged"));
  assert.equal(ops.at(-1).value, null);
  const many = Object.fromEntries(
    Array.from({ length: 11 }, (_, i) => ["f" + i, i]),
  );
  assert.throws(() => buildDocumentPatch({}, many, []), /最多 10/);
});
test("field paths protect partition parents, avoid prototype mutation and reject missing parents", () => {
  assert.equal(protectedField("/scope", ["/scope/tenant"]), true);
  assert.equal(protectedField("/scope/tenant/child", ["/scope/tenant"]), true);
  assert.equal(protectedField("/scope/name", ["/scope/tenant"]), false);
  assert.throws(() => editDocumentField({ id: "one" }, "/id", "two", []));
  assert.throws(() => editDocumentField({}, "/absent/child", 1, []));
  assert.throws(() => editDocumentField({}, "/bad~2", 1, []));
  const doc = editDocumentField({}, "/__proto__", { safe: true }, []);
  assert.equal({}.safe, undefined);
  assert.ok(Object.hasOwn(doc, "__proto__"));
  assert.equal(documentPathExists({ scope: { child: 1 } }, "/scope"), true);
});
