import { startDevelopment } from "../node_modules/@dbx-app/plugin-cli/dev-runtime/runtime.mjs";
import { normalizeDevPaths } from "./dev-paths.mjs";

if (process.argv[2] !== "--config" || !process.argv[3])
  throw new Error("Start this runtime through npm run dev");
try {
  await startDevelopment(normalizeDevPaths(JSON.parse(process.argv[3])));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
