import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sqlExecution,
  validateSQLExecution,
  sqlErrorDiagnostic,
} from "../src/sql-execution.mjs";
const select = (from, to = from, ranges = 1) => ({
  main: { from, to, empty: from === to },
  ranges: Array(ranges).fill({ from, to }),
});

test("SQL execution preserves exact selection text, offsets and source lines", () => {
  const prefix = "-- 😀 中文\nSELECT c.id FROM c\n";
  const query = "  SELECT * FROM c WHERE c.total = 9223372036854775807\n";
  const text = prefix + query + "BAD";
  const execution = sqlExecution(
    text,
    select(prefix.length, prefix.length + query.length),
  );
  assert.equal(execution.query, query);
  assert.equal(execution.document, text);
  assert.equal(execution.from, prefix.length);
  assert.equal(execution.to, prefix.length + query.length);
  assert.equal(execution.selected, true);
  assert.equal(execution.startLine, 3);
  assert.equal(execution.endLine, 3);
  validateSQLExecution(execution);
});

test("no selection runs the full document; whitespace and multiple ranges never fall back", () => {
  const execution = sqlExecution("SELECT * FROM c", select(5));
  assert.equal(execution.query, "SELECT * FROM c");
  assert.equal(execution.selected, false);
  validateSQLExecution(execution);
  assert.throws(
    () =>
      validateSQLExecution(sqlExecution("SELECT * FROM c\n  ", select(16, 18))),
    /未执行全文/,
  );
  assert.throws(
    () => validateSQLExecution(sqlExecution(" \n", select(0))),
    /请输入 SQL/,
  );
  assert.throws(
    () =>
      validateSQLExecution(sqlExecution("SELECT * FROM c", select(0, 6, 2))),
    /多个选区/,
  );
});

test("SQL diagnostics map service offsets into the original selection and reject stale sources", () => {
  const prefix = "-- 😀\nSELECT c.id FROM c\n";
  const query = "SELECT * FROM c WHERE c.BAD = true";
  const text = prefix + query;
  const execution = sqlExecution(text, select(prefix.length, text.length));
  const error = {
    data: {
      status: 400,
      category: "sql-syntax",
      position: query.indexOf("BAD"),
    },
  };
  const d = sqlErrorDiagnostic(execution, text, error);
  assert.equal(d.from, prefix.length + query.indexOf("BAD"));
  assert.equal(text.slice(d.from, d.to), "B");
  assert.match(d.message, /第 3 行，第 25 列/);
  assert.equal(sqlErrorDiagnostic(execution, text + " ", error), null);
  const eof = sqlErrorDiagnostic(execution, text, {
    data: { status: 400, category: "sql-syntax", position: query.length },
  });
  assert.equal(eof.from, text.length);
  assert.equal(eof.to, text.length);
});

test("missing or invalid SQL positions are not guessed; sanitized old-host hints remain usable", () => {
  const text = "SELECT * FROM c AND true";
  const execution = sqlExecution(text, select(0));
  for (const position of [-1, 99, 1.5, "14", null, undefined]) {
    assert.equal(
      sqlErrorDiagnostic(execution, text, {
        data: { status: 400, category: "sql-syntax", position },
      }),
      null,
    );
  }
  assert.equal(
    sqlErrorDiagnostic(execution, text, {
      data: { status: 400, category: "index", position: 14 },
    }),
    null,
  );
  assert.equal(
    sqlErrorDiagnostic(execution, text, {
      message: "HTTP 400: SQL 语法错误：检查 WHERE",
    }),
    null,
  );
  const old = sqlErrorDiagnostic(execution, text, {
    message: "HTTP 400: SQL 语法错误：第 15 个字符附近。",
  });
  assert.equal(old.from, 14);
});
