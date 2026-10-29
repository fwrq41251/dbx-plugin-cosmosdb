import { renderMessage, message as msg, LocalizedError } from "./i18n.mjs";
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
      throw new LocalizedError(
        msg("ui.partitionKeyContainsALargeIntegerEnter"),
      );
    return value;
  });
  return stringify(values.length ? values : [{}]);
}
export function parseArray(text, label) {
  const value = parse(text);
  if (!Array.isArray(value))
    throw new LocalizedError(
      msg("errors.arrayRequired", () => [renderMessage(label)]),
    );
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
  return [...keys];
}
export function formatJSON(text) {
  // Add whitespace lexically so 64-bit integers and decimal literals remain exact.
  let out = "",
    indent = 0,
    quoted = false,
    escaped = false,
    previous = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      previous = ch;
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
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] !== (ch === "{" ? "}" : "]"))
        out += "\n" + "  ".repeat(indent);
    } else if (ch === "}" || ch === "]") {
      indent--;
      if (previous !== "{" && previous !== "[")
        out += "\n" + "  ".repeat(indent);
      out += ch;
    } else if (ch === ",") out += ",\n" + "  ".repeat(indent);
    else if (ch === ":") out += ": ";
    else out += ch;
    previous = ch;
  }
  return out;
}
