import test from "node:test";
import assert from "node:assert/strict";
import { createQueryInputs, defaultQueryInput } from "../src/query-inputs.mjs";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const target = (container) => ({
  connectionId: "one",
  database: "db",
  container,
});

test("late restores cannot overwrite edits or another container; saves capture their original scope", async () => {
  let value = defaultQueryInput();
  const reads = new Map(),
    writes = [],
    failures = [];
  const inputs = createQueryInputs({
    read: () => value,
    apply: (v) => {
      value = v;
      inputs.changed();
    },
    failed: (k) => failures.push(k),
    invoke: async (method, params) => {
      if (params.queryInput) {
        writes.push(params);
        return params.queryInput;
      }
      const read = deferred();
      reads.set(params.container, read);
      return read.promise;
    },
  });
  const a = inputs.activate(target("a"));
  await Promise.resolve();
  value = { ...value, sql: "unfinished SQL", partitionKeyText: '["draft' };
  inputs.changed();
  const b = inputs.activate(target("b"));
  await Promise.resolve();
  reads.get("b").resolve({ ...defaultQueryInput(), sql: "saved B" });
  await b;
  reads.get("a").resolve({ ...defaultQueryInput(), sql: "old A" });
  await a;
  assert.equal(value.sql, "saved B");
  await inputs.activate(target("a"));
  assert.equal(value.sql, "unfinished SQL");
  assert.equal(writes[0].container, "a");
  assert.equal(writes[0].queryInput.partitionKeyText, '["draft');
  inputs.reset();
  assert.deepEqual(value, defaultQueryInput());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(writes.at(-1).queryInput, defaultQueryInput());
  assert.deepEqual(failures, []);
});

test("storage failures preserve input, permit reset and do not issue queries", async () => {
  let value = defaultQueryInput();
  const failures = [],
    methods = [];
  const inputs = createQueryInputs({
    read: () => value,
    apply: (v) => (value = v),
    failed: (k) => failures.push(k),
    invoke: async (method) => {
      methods.push(method);
      throw new Error("storage unavailable");
    },
  });
  await inputs.activate(target("a"));
  value = { ...value, sql: "my SQL" };
  inputs.changed();
  await new Promise((r) => setImmediate(r));
  assert.equal(value.sql, "my SQL");
  assert.deepEqual(failures, ["load", "save"]);
  inputs.deactivate();
  await inputs.activate(target("a"));
  assert.equal(value.sql, "my SQL");
  assert.ok(methods.every((method) => method === "cosmos/queryInput"));
  inputs.reset();
  assert.deepEqual(value, defaultQueryInput());
});
