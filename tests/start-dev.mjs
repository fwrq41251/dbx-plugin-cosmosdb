import { spawn } from "node:child_process";
import { readRun } from "./e2e-run.mjs";
const run = readRun();
async function execute(args) {
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
  });
  const interrupt = () => child.kill("SIGINT"),
    terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
let code = await execute(["scripts/build-ui.mjs"]);
if (code === 0)
  code = await execute([
    "scripts/dbx-cli.mjs",
    "dev",
    "--path",
    ".",
    "--port",
    String(run.uiPort),
    "--data-dir",
    run.hostData,
  ]);
process.exitCode = code;
