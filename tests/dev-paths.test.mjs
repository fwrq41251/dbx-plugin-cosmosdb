import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDevPaths } from "../scripts/dev-paths.mjs";

test("Windows dev launch strips verbatim path prefixes without changing build flags or input config", () => {
  const config = {
    project: "\\\\?\\D:\\cosmos project 中文",
    dataDir: "\\\\?\\C:\\Users\\dev\\Temp",
    backend: "\\\\?\\C:\\Users\\dev\\Temp\\sidecar.exe",
    backendWatch: "\\\\?\\D:\\cosmos project 中文\\backend",
    port: 5190,
    commands: {
      backend: { command: "go", args: ["build", "-trimpath", "-o", "\\\\?\\C:\\Users\\dev\\Temp\\sidecar.exe", "."], cwd: "\\\\?\\D:\\cosmos project 中文\\backend", goWorkspace: ["\\\\?\\D:\\cosmos project 中文\\backend"] },
      ui: ["node", "scripts/build-ui.mjs"],
      watch: [],
    },
  };
  const original = structuredClone(config);
  const normalized = normalizeDevPaths(config, "win32");
  assert.equal(normalized.project, "D:\\cosmos project 中文");
  assert.equal(normalized.backend, "C:\\Users\\dev\\Temp\\sidecar.exe");
  assert.equal(normalized.commands.backend.cwd, "D:\\cosmos project 中文\\backend");
  assert.deepEqual(normalized.commands.backend.args, ["build", "-trimpath", "-o", "C:\\Users\\dev\\Temp\\sidecar.exe", "."]);
  assert.deepEqual(normalized.commands.backend.goWorkspace, ["D:\\cosmos project 中文\\backend"]);
  assert.deepEqual(normalized.commands.ui, config.commands.ui);
  assert.deepEqual(config, original);
  assert.equal(normalizeDevPaths(config, "darwin"), config);
  assert.equal(normalizeDevPaths(config, "linux"), config);
  assert.equal(normalizeDevPaths({ project: "\\\\?\\UNC\\server\\share\\project" }, "win32").project, "\\\\server\\share\\project");
});
