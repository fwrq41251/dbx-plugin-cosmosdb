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
  return {
    hidden: Array.isArray(value?.hidden)
      ? value.hidden.filter((x) => typeof x === "string").slice(0, 500)
      : [],
    widths,
    pinId: value?.pinId !== false,
  };
}

export function visibleColumns(columns, preferences) {
  const visible = columns.filter((name) => !preferences.hidden.includes(name));
  if (preferences.pinId && visible.includes("id"))
    return ["id", ...visible.filter((name) => name !== "id")];
  return visible;
}

// A projection may omit a partition field; do not infer an undefined key or
// borrow the key typed for a different query. Only complete rows can point-read.
export function rowIdentity(row, paths) {
  if (!row || typeof row.id !== "string" || !paths.length) return null;
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
