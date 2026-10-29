import { message as msg, LocalizedError } from "./i18n.mjs";
import { parseJSON, encodeJSON } from "./model.mjs";
import { editableDocument, documentChanges } from "./documents.mjs";
import { isLosslessNumber } from "lossless-json";

export function pointerTokens(path) {
  if (!path.startsWith("/"))
    throw new LocalizedError(msg("ui.fieldPathsMustStartWithEG"));
  return path
    .slice(1)
    .split("/")
    .map((part) => {
      if (/~(?![01])/.test(part))
        throw new LocalizedError(msg("ui.escapeAndInFieldPathsAsAnd"));
      return part.replace(/~1/g, "/").replace(/~0/g, "~");
    });
}
export function protectedField(path, paths) {
  const field = pointerTokens(path);
  return [
    "/id",
    "/_rid",
    "/_self",
    "/_etag",
    "/_attachments",
    "/_ts",
    ...paths,
  ].some((p) => {
    const key = pointerTokens(p);
    return field
      .slice(0, Math.min(field.length, key.length))
      .every((part, index) => part === key[index]);
  });
}
export function fieldKind(value) {
  if (isLosslessNumber(value) || typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return "json";
}
function object(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isLosslessNumber(value)
  );
}
export function documentPathExists(doc, path) {
  for (const part of pointerTokens(path)) {
    if (!object(doc) || !Object.hasOwn(doc, part)) return false;
    doc = doc[part];
  }
  return true;
}
export function documentFields(document, paths) {
  const rows = [];
  function walk(doc, path) {
    for (const [key, value] of Object.entries(doc)) {
      const next = path + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1");
      if (object(value) && Object.keys(value).length) walk(value, next);
      else
        rows.push({
          path: next,
          value,
          kind: fieldKind(value),
          locked: protectedField(next, paths),
        });
    }
  }
  walk(editableDocument(document), "");
  return rows;
}
export function parseFieldInput(text, kind) {
  if (kind === "string") return text;
  const value = parseJSON(text);
  if (kind === "number" && fieldKind(value) !== "number")
    throw new LocalizedError(msg("ui.numberFieldsRequireAValidJsonNumber"));
  if (kind === "boolean" && typeof value !== "boolean")
    throw new LocalizedError(msg("ui.booleanFieldsMustBeTrueOrFalse"));
  return value;
}
export function editDocumentField(
  document,
  path,
  value,
  paths,
  remove = false,
) {
  if (protectedField(path, paths))
    throw new LocalizedError(msg("ui.cannotModifyIdPartitionKeyOrSystem"));
  const doc = parseJSON(encodeJSON(editableDocument(document))),
    parts = pointerTokens(path);
  let parent = doc;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(parent, part) || !object(parent[part]))
      throw new LocalizedError(msg("ui.parentFieldIsMissingOrIsNot"));
    parent = parent[part];
  }
  const last = parts.at(-1);
  if (remove) {
    if (!Object.hasOwn(parent, last))
      throw new LocalizedError(msg("ui.theFieldToDeleteDoesNotExist"));
    delete parent[last];
  } else
    Object.defineProperty(parent, last, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return doc;
}
export function buildDocumentPatch(before, after, paths) {
  const changes = documentChanges(before, after);
  if (changes.length > 10)
    throw new LocalizedError(
      msg("ui.operationsRequestedPatchSupportsAtMostReduce", () => [
        changes.length,
      ]),
    );
  return changes.map((change) => {
    if (protectedField(change.path, paths))
      throw new LocalizedError(msg("ui.patchCannotModifyIdPartitionKeyOr"));
    return change.kind === "remove"
      ? { op: "remove", path: change.path }
      : { op: "set", path: change.path, value: parseJSON(change.after) };
  });
}
