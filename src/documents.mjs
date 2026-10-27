import {
  parseJSON,
  encodeJSON,
  parseArray,
  keyFromDocument,
} from "./model.mjs";
import { isLosslessNumber } from "lossless-json";

const systemFields = new Set(["_rid", "_self", "_etag", "_attachments", "_ts"]);
function object(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isLosslessNumber(value)
  );
}
export function editableDocument(doc) {
  if (!object(doc)) throw new Error("文档必须是 JSON 对象");
  return Object.fromEntries(
    Object.entries(doc).filter(([key]) => !systemFields.has(key)),
  );
}
function tokens(path) {
  if (!path.startsWith("/")) throw new Error("无效的分区键路径");
  return path
    .slice(1)
    .split("/")
    .map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"));
}
export function applyDocumentPartition(doc, text, paths) {
  const values = parseArray(text, "分区键");
  if (values.length !== (paths.length || 1))
    throw new Error("分区键组件数量与容器定义不一致");
  values.forEach((value, index) => {
    if (Array.isArray(value) || (object(value) && Object.keys(value).length))
      throw new Error("分区键必须是标量、null 或 {}");
    if (!paths[index]) return;
    const parts = tokens(paths[index]),
      undefinedKey = object(value);
    let target = doc;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(target, part)) {
        if (undefinedKey) return;
        Object.defineProperty(target, part, {
          value: {},
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if (!object(target[part]))
        throw new Error("分区键路径与文档现有字段冲突");
      target = target[part];
    }
    const last = parts.at(-1);
    if (undefinedKey) delete target[last];
    else
      Object.defineProperty(target, last, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  });
  return doc;
}
export function newDocument(paths, partitionText, id) {
  const doc = { id };
  if (partitionText.trim()) applyDocumentPartition(doc, partitionText, paths);
  return doc;
}
export function prepareDocument(text, partitionText, paths, identity = null) {
  const doc = editableDocument(parseJSON(text));
  if (typeof doc.id !== "string" || !doc.id)
    throw new Error("文档必须包含非空字符串 id");
  const values = parseArray(partitionText, "分区键");
  if (values.length !== (paths.length || 1))
    throw new Error("分区键组件数量与容器定义不一致");
  const key = encodeJSON(values),
    actual = keyFromDocument(doc, paths);
  if (key !== actual)
    throw new Error(
      "文档正文的分区键与所选分区键不一致，请修正文档或重新选择分区键",
    );
  if (
    identity &&
    (doc.id !== identity.id ||
      key !== encodeJSON(parseArray(identity.partitionKeyText, "分区键")))
  )
    throw new Error("更新时不能更改 id 或分区键，请重新读取文档");
  return { doc, text: encodeJSON(doc), partitionKeyText: key };
}
export function documentChanges(before, after) {
  const changes = [];
  function visit(a, b, path, hasA = true, hasB = true) {
    if (!hasA || !hasB) {
      changes.push({
        path: path || "/",
        before: hasA ? encodeJSON(a) : "（不存在）",
        after: hasB ? encodeJSON(b) : "（删除）",
      });
      return;
    }
    if (object(a) && object(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
        visit(
          a[key],
          b[key],
          path + "/" + escaped,
          Object.hasOwn(a, key),
          Object.hasOwn(b, key),
        );
      }
    } else if (encodeJSON(a) !== encodeJSON(b))
      changes.push({
        path: path || "/",
        before: encodeJSON(a),
        after: encodeJSON(b),
      });
  }
  visit(editableDocument(before), editableDocument(after), "");
  return changes;
}
