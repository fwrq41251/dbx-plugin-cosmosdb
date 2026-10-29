import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const platform = { darwin: "darwin", win32: "windows", linux: "linux" }[process.platform];
if (!platform || !["x64", "arm64"].includes(process.arch))
  throw new Error("Unsupported native package verification platform");
const target = process.env.DBX_PLUGIN_TARGET || `${platform}-${process.arch}`;
const packagePath = join(root, "dist", `${manifest.id}-${manifest.version}-${target}.dbxp`);
const result = spawnSync(
  process.platform === "win32" ? "python" : "python3",
  [join(root, "scripts", "verify-package.py"), packagePath],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
