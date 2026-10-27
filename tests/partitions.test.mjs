import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PartitionCandidates,
  PartitionLoader,
  partitionLabel,
} from "../src/partitions.mjs";
test("candidate filtering deduplicates JSON whitespace and keeps scalar types and precision", () => {
  const cache = new PartitionCandidates();
  for (const key of [
    '[ "alpha" ]',
    '["alpha"]',
    "[42]",
    '["42"]',
    "[null]",
    "[{}]",
    "[9223372036854775807]",
  ])
    cache.add(key);
  assert.equal(cache.keys.size, 6);
  assert.equal(cache.filter("ALP")[0].key, '["alpha"]');
  assert.equal(cache.filter("42").length, 2);
  assert.equal(cache.filter("922337")[0].key, "[9223372036854775807]");
  assert.equal(partitionLabel("[{}]"), "未定义");
  assert.throws(() => cache.add('[{"x":1}]'));
  assert.throws(() => cache.add("[]"));
});

test("automatic loader reads through empty pages, retries throttling and stops at completion", async () => {
  const cache = new PartitionCandidates();
  let calls = 0;
  const tokens = [];
  const loader = new PartitionLoader(
    cache,
    "distinct",
    async (mode, token) => {
      tokens.push(token);
      if (++calls === 2)
        throw Object.assign(new Error("HTTP 429"), {
          data: { status: 429, retryAfterMs: "1" },
        });
      return {
        mode,
        keys: calls === 1 ? [] : ['["last"]'],
        continuation: calls === 1 ? "next" : "",
        scanned: 0,
        ru: 3,
      };
    },
    () => {},
    async () => {},
  );
  await loader.start();
  assert.deepEqual(tokens, ["", "next", "next"]);
  assert.equal(cache.filter("last").length, 1);
  assert.equal(cache.stats.distinct.pages, 2);
  await loader.start();
  assert.equal(calls, 3);
});

test("pause stops subsequent requests, resume keeps the cursor, and duplicate cursors surface an error", async () => {
  const cache = new PartitionCandidates();
  let resolvePage;
  let calls = 0;
  const loader = new PartitionLoader(cache, "distinct", async (mode, token) => {
    calls++;
    if (!token)
      await new Promise((resolve) => {
        resolvePage = resolve;
      });
    return {
      mode,
      keys: ['["first"]'],
      continuation: "next",
      scanned: 1,
      ru: 1,
    };
  });
  const pending = loader.start();
  loader.stop();
  resolvePage();
  await pending;
  assert.equal(calls, 1);
  assert.equal(cache.stats.distinct.continuation, "next");
  await loader.start();
  assert.equal(calls, 2);
  assert.match(loader.error, /重复分页/);
  assert.equal(cache.keys.size, 1);
});

test("unsupported seek surfaces an error without falling back to a scan", async () => {
  const cache = new PartitionCandidates();
  cache.add('["known"]');
  const modes = [];
  const loader = new PartitionLoader(cache, "seek", async (mode) => {
    modes.push(mode);
    throw new Error("HTTP 400");
  });
  await loader.start();
  assert.deepEqual(modes, ["seek"]);
  assert.equal(cache.keys.size, 1);
  assert.match(loader.error, /HTTP 400/);
});
test("sample and enumeration have independent progress; empty pages can have more", () => {
  const c = new PartitionCandidates();
  c.merge({
    mode: "sample",
    keys: ['["alpha"]'],
    continuation: "next",
    scanned: 100,
    ru: 3,
  });
  c.merge({
    mode: "distinct",
    keys: [],
    continuation: "empty-page",
    scanned: 0,
    ru: 20,
  });
  c.merge({
    mode: "distinct",
    keys: ['["alpha"]', '["beta"]'],
    continuation: "",
    scanned: 2,
    ru: 30,
  });
  assert.equal(c.keys.size, 2);
  assert.equal(c.stats.sample.continuation, "next");
  assert.equal(c.stats.distinct.ru, 50);
  assert.equal(c.stats.distinct.continuation, "");
  assert.equal(c.stats.distinct.pages, 2);
});

test("automatic discovery pauses at its RU budget without losing the resume cursor", async () => {
  const cache = new PartitionCandidates();
  let calls = 0;
  const loader = new PartitionLoader(cache, "seek", async (mode) => ({
    mode,
    keys: [],
    continuation: String(++calls),
    scanned: 0,
    ru: 1000,
  }));
  await loader.start();
  assert.equal(calls, 2);
  assert.equal(cache.stats.seek.continuation, "2");
  assert.match(loader.notice, /2000 RU/);
});
