import { isLosslessNumber } from "lossless-json";

const identifier = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const keywords = [
  "SELECT",
  "VALUE",
  "DISTINCT",
  "TOP",
  "FROM",
  "WHERE",
  "ORDER BY",
  "ASC",
  "DESC",
  "OFFSET",
  "LIMIT",
  "JOIN",
  "IN",
  "GROUP BY",
  "AS",
  "AND",
  "OR",
  "NOT",
  "BETWEEN",
  "LIKE",
  "EXISTS",
  "true",
  "false",
  "null",
];
const functions = [
  "IS_DEFINED",
  "IS_NULL",
  "IS_STRING",
  "IS_NUMBER",
  "IS_BOOL",
  "IS_ARRAY",
  "IS_OBJECT",
  "CONTAINS",
  "STARTSWITH",
  "ENDSWITH",
  "ARRAY_CONTAINS",
  "ARRAY_LENGTH",
  "LOWER",
  "UPPER",
  "LENGTH",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "IIF",
];

// Bounded field names only. Never retain document values or issue discovery queries.
export class KnownFields {
  paths = new Map();
  count = 0;
  learn(doc, path = [], depth = 0) {
    if (
      depth > 8 ||
      this.count >= 2000 ||
      doc === null ||
      typeof doc !== "object" ||
      isLosslessNumber(doc)
    )
      return;
    if (Array.isArray(doc)) {
      for (const item of doc.slice(0, 10)) this.learn(item, path, depth + 1);
      return;
    }
    const key = JSON.stringify(path);
    if (!this.paths.has(key)) this.paths.set(key, new Set());
    const fields = this.paths.get(key);
    for (const name of Object.keys(doc)) {
      if (this.count >= 2000) break;
      if (!fields.has(name)) {
        fields.add(name);
        this.count++;
      }
      this.learn(doc[name], [...path, name], depth + 1);
    }
  }
  children(path) {
    return [...(this.paths.get(JSON.stringify(path)) || [])];
  }
}

// Only the unmodified root projection is safe to learn from; aliases and computed
// projections can produce names that don't exist on stored documents.
export function hasRootProjection(sql) {
  return (
    /^\s*SELECT\s+(?:TOP\s+\d+\s+)?\*\s+FROM\s+[\p{L}_$][\p{L}\p{N}_$]*(?:\s+(?:WHERE|ORDER\s+BY|OFFSET|$)|\s*$)/iu.test(
      sql,
    ) && !/\bJOIN\b/i.test(sql)
  );
}

// Mask literals/comments while keeping offsets, so neither quoted text nor a
// comment can manufacture a FROM/JOIN alias or cause a completion popup.
function codeAt(text) {
  let mode = "",
    escaped = false,
    out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i],
      next = text[i + 1];
    if (mode === "line") {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "\n") mode = "";
    } else if (mode === "block") {
      out += " ";
      if (ch === "*" && next === "/") {
        out += " ";
        i++;
        mode = "";
      }
    } else if (mode) {
      out += " ";
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === mode) {
        if (next === mode) {
          out += " ";
          i++;
        } else mode = "";
      }
    } else if (ch === "-" && next === "-") {
      mode = "line";
      out += "  ";
      i++;
    } else if (ch === "/" && next === "*") {
      mode = "block";
      out += "  ";
      i++;
    } else if (ch === '"' || ch === "'") {
      mode = ch;
      out += " ";
    } else out += ch;
  }
  return { text: out, inLiteral: !!mode };
}

export function sqlCompletions(
  text,
  pos,
  { fields = new KnownFields(), parameters = [], explicit = false } = {},
) {
  const before = codeAt(text.slice(0, pos));
  if (before.inLiteral) return null;
  const code = codeAt(text).text;
  const aliases = new Map();
  const root = code.match(/\bFROM\s+([\p{L}_$][\p{L}\p{N}_$]*)/iu)?.[1];
  if (root) aliases.set(root, []);
  for (const m of code.matchAll(
    /\bJOIN\s+([\p{L}_$][\p{L}\p{N}_$]*)\s+IN\s+([\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*)/giu,
  )) {
    const [base, ...rest] = m[2].split(".");
    if (aliases.has(base)) aliases.set(m[1], [...aliases.get(base), ...rest]);
  }
  const member = before.text.match(
    /([\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*)\.([\p{L}\p{N}_$]*)$/u,
  );
  if (member) {
    const [alias, ...path] = member[1].split(".");
    if (!aliases.has(alias)) return null;
    const prefix = member[2],
      from = pos - prefix.length - 1;
    return {
      from,
      options: fields
        .children([...aliases.get(alias), ...path])
        .filter((x) => x.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((name) => ({
          label: "." + name,
          displayLabel: name,
          type: "property",
          detail: "已读取文档中的字段",
          apply: identifier.test(name)
            ? "." + name
            : `[${JSON.stringify(name)}]`,
        })),
    };
  }
  const parameter = before.text.match(/@[\p{L}\p{N}_$]*$/u);
  if (parameter)
    return {
      from: pos - parameter[0].length,
      options: [...new Set(parameters)]
        .filter((x) => x.startsWith(parameter[0]))
        .map((label) => ({ label, type: "variable", detail: "查询参数" })),
    };
  const word = before.text.match(/[\p{L}_$][\p{L}\p{N}_$]*$/u);
  if (!word && !explicit) return null;
  const prefix = word?.[0] || "";
  const options = [
    ...keywords.map((label) => ({ label, type: "keyword" })),
    ...functions.map((label) => ({
      label,
      type: "function",
      apply(view, _completion, from, to) {
        view.dispatch({
          changes: { from, to, insert: label + "()" },
          selection: { anchor: from + label.length + 1 },
        });
      },
    })),
    ...[...aliases.keys()].map((label) => ({
      label,
      type: "variable",
      detail: "文档别名",
    })),
  ].filter((x) => x.label.toLowerCase().startsWith(prefix.toLowerCase()));
  return { from: pos - prefix.length, options };
}
