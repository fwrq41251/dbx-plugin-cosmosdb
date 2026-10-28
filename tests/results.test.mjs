import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cellText,
  rowIdentity,
  tablePreferences,
  visibleColumns,
} from "../src/results.mjs";
import { parseJSON, columnsFor } from "../src/model.mjs";

test("all columns remain selectable; preferences bound widths and preserve hidden fields across pages", () => {
  const row = Object.fromEntries(
    Array.from({ length: 35 }, (_, i) => [`f${i}`, i]),
  );
  const columns = columnsFor([row, { id: "one" }]);
  assert.equal(columns.length, 36);
  const prefs = tablePreferences({
    hidden: ["f0", "field-not-on-this-page"],
    widths: { id: 9999, f1: 10, f2: NaN },
    pinId: true,
  });
  assert.equal(prefs.widths.id, 800);
  assert.equal(prefs.widths.f1, 80);
  assert.equal(prefs.widths.f2, undefined);
  assert.equal(visibleColumns(columns, prefs)[0], "id");
  assert.ok(!visibleColumns(columns, prefs).includes("f0"));
  assert.deepEqual(visibleColumns(["field-not-on-this-page", "x"], prefs), [
    "x",
  ]);
});
test("copy and point-read identities preserve exact numeric values and reject incomplete projections", () => {
  const row = parseJSON(
    '{"id":"one","tenant":9223372036854775807,"x":{"a/b":null},"list":[1,2]}',
  );
  assert.equal(cellText(row.tenant), "9223372036854775807");
  assert.equal(cellText(row.list), "[1,2]");
  assert.equal(cellText(null), "null");
  assert.equal(cellText("text"), "text");
  assert.deepEqual(rowIdentity(row, ["/tenant", "/x/a~1b"]), {
    id: "one",
    partitionKeyText: "[9223372036854775807,null]",
  });
  assert.equal(rowIdentity({ id: "projection" }, ["/tenant"]), null);
  assert.equal(rowIdentity({ tenant: "a" }, ["/tenant"]), null);
});
