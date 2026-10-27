import { parse, stringify, isLosslessNumber } from "lossless-json";
export { parse as parseJSON, stringify as encodeJSON };
// Document writes still send the editor's original text, never a reserialized preview.
export function keyFromDocument(document, paths) {
  const values = paths.map((path) => {
    const tokens = path
      .replace(/^\//, "")
      .split("/")
      .map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"));
    let value = document;
    for (const token of tokens) {
      if (
        value === null ||
        typeof value !== "object" ||
        !Object.hasOwn(value, token)
      )
        return {};
      value = value[token];
    }
    if (
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      Number.isInteger(value)
    )
      throw new Error("分区键包含大整数，请手动填写精确的分区键 JSON。");
    return value;
  });
  return stringify(values.length ? values : [{}]);
}
export function parseArray(text, label) {
  const value = parse(text);
  if (!Array.isArray(value)) throw new Error(`${label}必须是 JSON 数组`);
  return value;
}
export function columnsFor(rows) {
  const keys = new Set();
  for (const row of rows) {
    if (
      row !== null &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      !isLosslessNumber(row)
    )
      Object.keys(row).forEach((k) => keys.add(k));
    else keys.add("(value)");
  }
  return [...keys].slice(0, 20);
}
export function formatJSON(text) {
  // Add whitespace lexically so 64-bit integers and decimal literals remain exact.
  let out = "",
    indent = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      out += ch;
    } else if (/\s/.test(ch)) {
      continue;
    } else if (ch === "{" || ch === "[") {
      out += ch;
      indent++;
      if (text.slice(i + 1).trimStart()[0] !== (ch === "{" ? "}" : "]"))
        out += "\n" + "  ".repeat(indent);
    } else if (ch === "}" || ch === "]") {
      indent--;
      const prev = out.trimEnd().slice(-1);
      if (prev !== "{" && prev !== "[") out += "\n" + "  ".repeat(indent);
      out += ch;
    } else if (ch === ",") out += ",\n" + "  ".repeat(indent);
    else if (ch === ":") out += ": ";
    else out += ch;
  }
  return out;
}
