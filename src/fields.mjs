import { parseJSON, encodeJSON } from "./model.mjs";
import { editableDocument, documentChanges } from "./documents.mjs";
import { isLosslessNumber } from "lossless-json";

export function pointerTokens(path) {
  if (!path.startsWith("/"))
    throw new Error("字段路径必须以 / 开头，例如 /remark 或 /address/city");
  return path
    .slice(1)
    .split("/")
    .map((part) => {
      if (/~(?![01])/.test(part))
        throw new Error("字段路径中的 ~ 和 / 需要转义为 ~0 和 ~1");
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
    throw new Error("数值字段需要有效 JSON 数字，不要加引号");
  if (kind === "boolean" && typeof value !== "boolean")
    throw new Error("布尔字段必须为 true 或 false");
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
    throw new Error("不能修改 id、分区键或系统字段；请重新读取目标文档");
  const doc = parseJSON(encodeJSON(editableDocument(document))),
    parts = pointerTokens(path);
  let parent = doc;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(parent, part) || !object(parent[part]))
      throw new Error(
        "父字段不存在或不是对象，请先在 JSON 视图添加父对象；数组请整体编辑",
      );
    parent = parent[part];
  }
  const last = parts.at(-1);
  if (remove) {
    if (!Object.hasOwn(parent, last)) throw new Error("要删除的字段不存在");
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
    throw new Error(
      `本次有 ${changes.length} 个操作，局部更新最多 10 个。请减少改动，或在保存方式中明确选择完整替换。`,
    );
  return changes.map((change) => {
    if (protectedField(change.path, paths))
      throw new Error("局部更新不能修改 id、分区键或系统字段");
    return change.after === "（删除）"
      ? { op: "remove", path: change.path }
      : { op: "set", path: change.path, value: parseJSON(change.after) };
  });
}
