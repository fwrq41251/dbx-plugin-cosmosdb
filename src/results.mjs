import { encodeJSON, keyFromDocument } from "./model.mjs";

export function cellText(value) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return encodeJSON(value);
}

export function tablePreferences(value) {
  const widths = Object.create(null);
  for (const [key, size] of Object.entries(value?.widths || {}).slice(0, 500)) {
    if (Number.isFinite(size)) widths[key] = Math.max(80, Math.min(800, size));
  }
  // Older versions stored hidden columns and an optional pin setting. Ignore
  // them so every returned field is visible and id stays fixed at the left.
  return { widths };
}

export function tableColumns(columns) {
  return columns.includes("id")
    ? ["id", ...columns.filter((name) => name !== "id")]
    : columns;
}

// A projection may omit a partition field; do not infer an undefined key or
// borrow the key typed for a different query. Only complete rows can point-read.
export function rowIdentity(row, paths) {
  if (!row || typeof row.id !== "string" || !row.id || !paths.length)
    return null;
  for (const path of paths) {
    let value = row;
    for (const part of path
      .slice(1)
      .split("/")
      .map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      if (
        value === null ||
        typeof value !== "object" ||
        !Object.hasOwn(value, part)
      )
        return null;
      value = value[part];
    }
  }
  return { id: row.id, partitionKeyText: keyFromDocument(row, paths) };
}
