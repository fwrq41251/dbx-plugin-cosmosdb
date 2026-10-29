import { spawn } from "node:child_process";
import { createRun, cleanupRun } from "../tests/e2e-run.mjs";
const run = await createRun();
console.log(`Isolated E2E run: ${run.id}`);
console.log(`Browser artifacts: ${run.artifacts}`);
let child;
const forward = (signal) => child?.kill(signal);
const interrupt = () => forward("SIGINT"),
  terminate = () => forward("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  child = spawn(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, COSMOS_E2E_RUN_FILE: run.file },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  });
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  if (process.env.COSMOS_E2E_KEEP === "1")
    console.log(`Retained E2E context: ${run.root}`);
  else {
    await cleanupRun(run);
    console.log(`Cleaned E2E context: ${run.id}`);
  }
}
