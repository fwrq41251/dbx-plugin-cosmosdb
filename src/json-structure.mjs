import { t, setText, setAttr, renderMessage, message as msg } from "./i18n.mjs";
import { jsonLanguage } from "@codemirror/lang-json";
import { ViewPlugin, Decoration } from "@codemirror/view";
import { codeFolding, foldGutter } from "@codemirror/language";

// Read syntax nodes rather than JSON.parse: duplicate keys and numeric precision
// must not be changed by a display-only feature.
export function indexJSON(text) {
  const nodes = [],
    stack = [];
  let valid = true;
  jsonLanguage.parser.parse(text).iterate({
    enter(ref) {
      if (ref.type.isError) valid = false;
      if (ref.name !== "Object" && ref.name !== "Array") return;
      let count = 0;
      for (let child = ref.node.firstChild; child; child = child.nextSibling) {
        if (
          ref.name === "Object"
            ? child.name === "Property"
            : /^(Object|Array|String|Number|True|False|Null)$/.test(child.name)
        )
          count++;
      }
      const node = {
        from: ref.from,
        to: ref.to,
        parent: stack.at(-1) ?? -1,
        kind: ref.name,
        count,
      };
      stack.push(nodes.length);
      nodes.push(node);
    },
    leave(ref) {
      if (ref.name === "Object" || ref.name === "Array") stack.pop();
    },
  });
  return { valid, nodes };
}
const cache = new WeakMap();
function structure(state) {
  let index = cache.get(state.doc);
  if (!index) {
    index = indexJSON(state.doc.toString());
    for (const node of index.nodes) {
      const line = state.doc.lineAt(node.from);
      node.line = line.number;
      node.endLine = state.doc.lineAt(node.to).number;
      let columns = 0;
      for (const ch of line.text.match(/^[ \t]*/)[0])
        columns += ch === "\t" ? state.tabSize - (columns % state.tabSize) : 1;
      node.indent = columns;
    }
    index.byRange = new Map(
      index.nodes.map((n) => [`${n.from + 1}:${n.to - 1}`, n]),
    );
    cache.set(state.doc, index);
  }
  return index;
}
function containing(index, position) {
  let low = 0,
    high = index.nodes.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (index.nodes[mid].from <= position) low = mid + 1;
    else high = mid;
  }
  let i = low - 1;
  while (i >= 0 && index.nodes[i].to <= position) i = index.nodes[i].parent;
  return i;
}
function guides(view) {
  const index = structure(view.state);
  if (!index.valid) return Decoration.none;
  const active = containing(index, view.state.selection.main.head);
  const decorations = [],
    seen = new Set();
  for (const range of view.visibleRanges) {
    let line = view.state.doc.lineAt(range.from);
    while (line.from <= range.to) {
      if (!seen.has(line.from)) {
        seen.add(line.from);
        const columns = new Map();
        for (
          let i = containing(index, line.from);
          i >= 0;
          i = index.nodes[i].parent
        ) {
          const node = index.nodes[i];
          if (node.line < line.number && node.endLine > line.number)
            columns.set(node.indent, columns.get(node.indent) || i === active);
        }
        if (columns.size) {
          const entries = [...columns];
          decorations.push(
            Decoration.line({
              attributes: {
                class: "cm-json-guides",
                style: `background-image:${entries.map(([, active]) => `linear-gradient(${active ? "var(--accent)" : "var(--line)"},${active ? "var(--accent)" : "var(--line)"})`).join(",")};background-position:${entries.map(([column]) => `calc(6px + ${column}ch) 0`).join(",")};background-size:1px 100%;background-repeat:no-repeat`,
              },
            }).range(line.from),
          );
        }
      }
      if (line.number === view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return Decoration.set(decorations, true);
}
export function jsonStructure() {
  return [
    ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.decorations = guides(view);
        }
        update(update) {
          if (
            update.docChanged ||
            update.viewportChanged ||
            update.selectionSet
          )
            this.decorations = guides(update.view);
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    codeFolding({
      preparePlaceholder(state, range) {
        const index = structure(state),
          node = index.byRange.get(`${range.from}:${range.to}`);
        return index.valid && node
          ? msg(
              node.kind === "Object" ? "json.foldedFields" : "json.foldedItems",
              () => [node.count],
            )
          : "…";
      },
      placeholderDOM(view, onclick, summary) {
        const span = document.createElement("span");
        span.className = "cm-foldPlaceholder cm-json-fold-summary";
        setText(span, () => renderMessage(summary));
        setAttr(span, "title", () =>
          t("json.expandHere", () => [
            renderMessage(summary).replace("… ", ""),
          ]),
        );
        setAttr(span, "aria-label", () => span.title);
        span.setAttribute("role", "button");
        span.tabIndex = 0;
        span.onclick = onclick;
        span.onkeydown = (event) => {
          if (event.key === "Enter" || event.key === " ") {
            onclick(event);
            view.focus();
          }
        };
        return span;
      },
    }),
    foldGutter({
      markerDOM(open) {
        const marker = document.createElement("span");
        marker.className = "cm-json-fold-toggle";
        setAttr(marker, "title", () =>
          open ? t("editor.foldLine") : t("editor.unfoldLine"),
        );
        marker.setAttribute("aria-hidden", "true");
        marker.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="${open ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"}"/></svg>`;
        return marker;
      },
    }),
  ];
}
