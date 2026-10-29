import { test } from "node:test";
import assert from "node:assert/strict";
import {
  keyFromDocument,
  parseArray,
  columnsFor,
  formatJSON,
  parseJSON,
  encodeJSON,
} from "../src/model.mjs";
test("partition keys preserve types and decode JSON pointer escapes", () => {
  assert.equal(
    keyFromDocument({ "a/b": { "~value": false }, n: null }, [
      "/a~1b/~0value",
      "/n",
      "/missing",
    ]),
    "[false,null,{}]",
  );
  assert.equal(keyFromDocument({}, []), "[{}]");
  assert.throws(
    () => keyFromDocument({ id: 9223372036854775807 }, ["/id"]),
    /大整数/,
  );
});
test("table values and inferred partition keys keep 64-bit precision", () => {
  const row = parseJSON('{"id":"one","n":9223372036854775807}');
  assert.equal(encodeJSON(row.n), "9223372036854775807");
  assert.equal(keyFromDocument(row, ["/n"]), "[9223372036854775807]");
  assert.deepEqual(columnsFor([parseJSON("123")]), ["(value)"]);
});
test("scalar and mixed projection columns", () => {
  assert.deepEqual(columnsFor([{ a: 1 }, { b: 2 }, 5]), ["a", "b", "(value)"]);
  assert.throws(() => parseArray("{}", "参数"), /数组/);
});
test("formatting is lexical and keeps precise numbers and escaped strings", () => {
  const source =
    '{"id":"a\\\"b","n":9223372036854775807,"nested":[{},[],{"d":0.12345678901234567890}]}';
  const formatted = formatJSON(source);
  assert.ok(formatted.includes("9223372036854775807"));
  assert.ok(formatted.includes("0.12345678901234567890"));
  assert.deepEqual(JSON.parse(formatted), JSON.parse(source));
});

test("formatting a broad JSON page and whitespace-only empty containers preserves every token", () => {
  const source = JSON.stringify(
    Array.from({ length: 12000 }, (_, i) => ({
      id: String(i),
      nested: { value: i },
    })),
  );
  const formatted = formatJSON(source);
  assert.deepEqual(JSON.parse(formatted), JSON.parse(source));
  assert.equal(
    formatJSON(
      '{ "a": { \n }, "b": [ \t ], "s": "space  ] }", "n": 1.2300e+20 }',
    ),
    '{\n  "a": {},\n  "b": [],\n  "s": "space  ] }",\n  "n": 1.2300e+20\n}',
  );
});
