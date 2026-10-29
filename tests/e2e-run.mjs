import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

const owner = "dbx-cosmosdb-playwright";
export async function createRun() {
  const root = await mkdtemp(join(tmpdir(), "dbx-cosmos-e2e-"));
  const servers = [createServer(), createServer()];
  try {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((accept, reject) =>
            server.once("error", reject).listen(0, "127.0.0.1", accept),
          ),
      ),
    );
    const [mockPort, uiPort] = servers.map((server) => server.address().port);
    const id = basename(root),
      run = {
        owner,
        token: randomUUID(),
        root,
        id,
        mockPort,
        uiPort,
        mockURL: `http://127.0.0.1:${mockPort}`,
        hostURL: `http://127.0.0.1:${uiPort}`,
        hostData: join(root, "host"),
        pluginData: join(root, "plugin"),
        sdkRoot: join(root, "sdk-root"),
        artifacts: resolve("test-results", id),
        file: join(root, "run.json"),
      };
    await Promise.all(
      [run.hostData, run.pluginData, run.artifacts].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    );
    await writeFile(run.file, JSON.stringify(run), { mode: 0o600 });
    return run;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    await Promise.all(
      servers.map((server) => new Promise((done) => server.close(done))),
    );
  }
}
export function readRun() {
  const file = process.env.COSMOS_E2E_RUN_FILE;
  if (!file)
    throw new Error(
      "Run browser tests with npm run test:browser (isolated run context required)",
    );
  const run = JSON.parse(readFileSync(file, "utf8"));
  if (run.owner !== owner || resolve(file) !== resolve(run.root, "run.json"))
    throw new Error("Invalid E2E run context");
  return run;
}
export async function cleanupRun(run) {
  const root = await realpath(run.root);
  const temp = await realpath(tmpdir());
  if (dirname(root) !== temp || !basename(root).startsWith("dbx-cosmos-e2e-"))
    throw new Error("Refusing to clean an unrelated directory");
  const saved = JSON.parse(await readFile(join(root, "run.json"), "utf8"));
  if (
    saved.owner !== owner ||
    saved.token !== run.token ||
    saved.root !== run.root
  )
    throw new Error("E2E ownership mismatch");
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 100,
  });
}
export function capturePath(name) {
  if (process.env.COSMOS_UPDATE_SCREENSHOTS === "1")
    return resolve("docs", basename(name));
  const path = join(readRun().artifacts, "captures", basename(name));
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
