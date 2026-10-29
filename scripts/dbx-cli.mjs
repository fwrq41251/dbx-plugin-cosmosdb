// Prevent the CLI's bundled SDK from silently replacing our pinned DBX 0.6.49 SDK.
import { cp, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = new URL("../", import.meta.url);
const sdkRoot = process.env.COSMOS_E2E_SDK_ROOT
  ? pathToFileURL(process.env.COSMOS_E2E_SDK_ROOT + "/")
  : new URL(".dbx-build/sdk-root/", root);
const target = new URL("plugins/sdk/go/dbx-plugin-sdk/", sdkRoot);
await mkdir(target, { recursive: true });
await cp(new URL("backend/third_party/dbx-plugin-sdk/", root), target, {
  recursive: true,
});
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("node_modules/@dbx-app/plugin-cli/bin/dbx-plugin.js", root),
    ),
    ...process.argv.slice(2),
  ],
  {
    cwd: fileURLToPath(root),
    stdio: "inherit",
    env: {
      ...process.env,
      DBX_PLUGIN_SDK_ROOT: fileURLToPath(sdkRoot),
      ...(process.argv[2] === "dev"
        ? {
            ...(process.platform === "win32"
              ? {
                  DBX_PLUGIN_DEV_RUNTIME:
                    process.env.DBX_PLUGIN_DEV_RUNTIME ||
                    fileURLToPath(new URL("dev-runtime.mjs", import.meta.url)),
                }
              : {}),
            DBX_PLUGIN_DATA_DIR:
              process.env.DBX_PLUGIN_DATA_DIR ||
              fileURLToPath(new URL(".dbx-dev/plugin-data/", root)),
          }
        : {}),
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
