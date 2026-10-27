import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { build } from "esbuild";
const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const styles = await read("src/styles.css");
const bundle = await build({
  entryPoints: [new URL("src/app.mjs", root).pathname],
  bundle: true,
  format: "iife",
  write: false,
  target: "safari15",
  legalComments: "inline",
});
const script = bundle.outputFiles[0].text.replaceAll("</script", "<\\/script");
const html = (await read("src/index.html"))
  .replace("/* STYLE */", () => styles)
  .replace("/* SCRIPT */", () => script);
await mkdir(new URL("ui/", root), { recursive: true });
await writeFile(new URL("ui/index.html", root), html);
await mkdir(new URL("ui/licenses/", root), { recursive: true });
for (const [source, target] of [
  ["LICENSE", "plugin-MIT.txt"],
  ["backend/third_party/dbx-plugin-sdk/LICENSE", "DBX-Apache-2.0.txt"],
  ["node_modules/lossless-json/LICENSE.md", "lossless-json-MIT.txt"],
])
  await copyFile(new URL(source, root), new URL("ui/licenses/" + target, root));
console.log("Built ui/index.html");
