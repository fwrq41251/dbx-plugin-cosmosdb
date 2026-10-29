import { localizeManifest } from "./localize-manifest.mjs";
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { build } from "esbuild";
async function atomicWrite(path, data) {
  const temporary = new URL(path.href + `.${process.pid}.tmp`);
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const manifestSource = await read("manifest.json");
const manifest =
  JSON.stringify(localizeManifest(JSON.parse(manifestSource)), null, 2) + "\n";
if (manifest !== manifestSource)
  await atomicWrite(new URL("manifest.json", root), manifest);
const styles = await read("src/styles.css");
const bundle = await build({
  entryPoints: [new URL("src/app.mjs", root).pathname],
  bundle: true,
  format: "iife",
  write: false,
  target: "safari15",
  legalComments: "inline",
});
const script = bundle.outputFiles[0].text
  .replaceAll("</script", "<\\/script")
  .replace(/[\t ]+$/gm, "");
const html = (await read("src/index.html"))
  .replace("/* STYLE */", () => styles)
  .replace("/* SCRIPT */", () => script);
await mkdir(new URL("ui/", root), { recursive: true });
await atomicWrite(new URL("ui/index.html", root), html);
await mkdir(new URL("ui/licenses/", root), { recursive: true });
for (const [source, target] of [
  ["LICENSE", "plugin-MIT.txt"],
  ["backend/third_party/dbx-plugin-sdk/LICENSE", "DBX-Apache-2.0.txt"],
  ["node_modules/lossless-json/LICENSE.md", "lossless-json-MIT.txt"],
])
  await copyFile(new URL(source, root), new URL("ui/licenses/" + target, root));
// Ship license texts for all bundled production dependencies, including transitives.
const shipped = new Set();
async function shipLicense(name) {
  if (shipped.has(name)) return;
  shipped.add(name);
  const dir = new URL(`node_modules/${name}/`, root);
  const pkg = JSON.parse(await readFile(new URL("package.json", dir), "utf8"));
  const file = (await readdir(dir)).find((x) => /^licen[cs]e(?:\.|$)/i.test(x));
  if (!file) throw new Error(`Missing bundled dependency license: ${name}`);
  await copyFile(
    new URL(file, dir),
    new URL(
      `ui/licenses/${name.replaceAll("/", "-").replaceAll("@", "")}-LICENSE.txt`,
      root,
    ),
  );
  for (const dependency of Object.keys(pkg.dependencies || {}))
    await shipLicense(dependency);
}
const pkg = JSON.parse(await read("package.json"));
for (const name of Object.keys(pkg.dependencies)) await shipLicense(name);
console.log("Built ui/index.html");
