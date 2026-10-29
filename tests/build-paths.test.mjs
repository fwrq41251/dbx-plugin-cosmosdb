import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
test("UI builds from a project path containing spaces and non-ASCII characters", async () => {
  const project = await mkdtemp(join(tmpdir(), "cosmos build-中文-"));
  try {
    for (const name of ["src", "scripts", "package.json", "manifest.json", "LICENSE", "backend/third_party/dbx-plugin-sdk/LICENSE"]) {
      const target = join(project, name);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(root, name), target, { recursive: true });
    }
    await symlink(join(root, "node_modules"), join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const result = spawnSync(process.execPath, [join(project, "scripts", "build-ui.mjs")], {
      cwd: project, encoding: "utf8", timeout: 30000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const html = await readFile(join(project, "ui", "index.html"), "utf8");
    assert.ok(html.includes("Cosmos DB"));
    assert.ok((await readFile(join(project, "ui", "licenses", "DBX-Apache-2.0.txt"), "utf8")).includes("Apache"));
  } finally {
    await rm(project, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
