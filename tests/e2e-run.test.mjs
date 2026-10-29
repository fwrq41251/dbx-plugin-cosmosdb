import test from "node:test";
import assert from "node:assert/strict";
import { access, rm, writeFile } from "node:fs/promises";
import { createRun, cleanupRun } from "./e2e-run.mjs";

test("browser runs own independent ports, storage and ownership-checked cleanup", async () => {
  const [a, b] = await Promise.all([createRun(), createRun()]);
  try {
    assert.notEqual(a.root, b.root);
    assert.equal(new Set([a.mockPort, a.uiPort, b.mockPort, b.uiPort]).size, 4);
    assert.notEqual(a.pluginData, b.pluginData);
    assert.notEqual(a.sdkRoot, b.sdkRoot);
    await assert.rejects(
      cleanupRun({ ...a, token: "wrong-owner" }),
      /ownership mismatch/,
    );
    await access(a.pluginData);
    await writeFile(a.pluginData + "/test-cache", "private");
    await cleanupRun(a);
    await assert.rejects(access(a.root), { code: "ENOENT" });
    await access(b.root);
  } finally {
    for (const run of [a, b]) {
      try {
        await cleanupRun(run);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      await rm(run.artifacts, { recursive: true, force: true });
    }
  }
});
