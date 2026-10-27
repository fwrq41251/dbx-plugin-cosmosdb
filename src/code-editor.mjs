import { nestedJSONFolds } from "./json-folding.mjs";
import { basicSetup } from "codemirror";
import {
  EditorState,
  Compartment,
  Transaction,
  EditorSelection,
} from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { indentWithTab, isolateHistory } from "@codemirror/commands";
import { json, jsonLanguage } from "@codemirror/lang-json";
import { sql, SQLDialect } from "@codemirror/lang-sql";
import { linter } from "@codemirror/lint";
import { openSearchPanel, getSearchQuery } from "@codemirror/search";
import { autocompletion } from "@codemirror/autocomplete";
import {
  foldEffect,
  foldedRanges,
  unfoldAll,
  syntaxHighlighting,
  HighlightStyle,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { parseJSON, formatJSON } from "./model.mjs";

const phrases = {
  Find: "查找",
  Replace: "替换",
  next: "下一项",
  previous: "上一项",
  all: "全部",
  "match case": "区分大小写",
  "by word": "全词匹配",
  regexp: "正则表达式",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "No diagnostics": "没有错误",
  "Fold line": "折叠此行",
  "Unfold line": "展开此行",
  to: "至",
  "on line": "所在行",
};
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "var(--syntax-string)",
  },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  { tag: tags.propertyName, color: "var(--syntax-property)" },
  { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
  {
    tag: [tags.function(tags.variableName), tags.standard(tags.name)],
    color: "var(--syntax-function)",
  },
]);
const cosmosDialect = SQLDialect.define({
  keywords:
    "select value distinct top from where order by asc desc offset limit join in group as and or not between like exists true false null",
  builtin:
    "is_defined is_null is_string is_number is_bool is_array is_object contains startswith endswith array_contains array_length lower upper length count sum avg min max iif",
  doubleQuotedStrings: true,
});

export function jsonDiagnostic(text) {
  try {
    parseJSON(text);
    return null;
  } catch {
    let from = text.length,
      to = text.length;
    jsonLanguage.parser.parse(text).iterate({
      enter(node) {
        if (node.type.isError && from === text.length) {
          from = node.from;
          to = node.to;
          return false;
        }
      },
    });
    const lines = text.slice(0, from).split("\n"),
      line = lines.length,
      column = lines.at(-1).length + 1;
    return {
      from,
      to,
      severity: "error",
      message: `JSON 格式错误：第 ${line} 行，第 ${column} 列。请检查逗号、引号、括号或字段值。`,
    };
  }
}

export function createCodeEditor(
  parent,
  {
    label,
    value = "",
    language = "json",
    readOnly = false,
    hint = "",
    completion,
    diagnostics,
  } = {},
) {
  const access = new Compartment();
  let locked = readOnly,
    onChange = () => {},
    lastDiagnostic;
  const status = document.createElement("div");
  status.className = "editor-status";
  let previousQuery,
    previousDoc,
    matches = [],
    capped = false;
  let foldDoc,
    nestedFolds = [];
  function foldRanges() {
    if (foldDoc !== view.state.doc) {
      foldDoc = view.state.doc;
      nestedFolds = nestedJSONFolds(view.state.doc.toString());
    }
    return nestedFolds;
  }
  function updateStatus(state) {
    const query = getSearchQuery(state);
    if (query !== previousQuery || state.doc !== previousDoc) {
      previousQuery = query;
      previousDoc = state.doc;
      matches = [];
      capped = false;
      if (query.valid) {
        const cursor = query.getCursor(state);
        for (let next = cursor.next(); !next.done; next = cursor.next()) {
          if (matches.length === 10000) {
            capped = true;
            break;
          }
          matches.push(next.value);
        }
      }
    }
    const selection = state.selection.main,
      line = state.doc.lineAt(selection.head);
    const current = matches.findIndex(
      (m) => m.from === selection.from && m.to === selection.to,
    );
    const count = foldedRanges(state).size;
    status.textContent =
      `第 ${line.number} 行，第 ${selection.head - line.from + 1} 列${state.readOnly ? " · 只读" : ""}${count ? ` · 已折叠 ${count} 处` : ""}` +
      (query.search
        ? ` · 匹配 ${current >= 0 ? `${current + 1} / ` : ""}${matches.length}${capped ? "+" : ""} 项`
        : "");
  }
  const report = () => {
    if (!diagnostics) return;
    const text = view.state.doc.toString();
    lastDiagnostic = locked && !text.trim() ? null : jsonDiagnostic(text);
    diagnostics(lastDiagnostic);
  };
  const extensions = [
    basicSetup,
    EditorState.phrases.of(phrases),
    EditorView.contentAttributes.of({
      "aria-label": label,
      spellcheck: "false",
      autocapitalize: "off",
    }),
    keymap.of([indentWithTab]),
    EditorView.lineWrapping,
    syntaxHighlighting(highlight),
    EditorView.updateListener.of((update) => {
      updateStatus(update.state);
      if (update.docChanged) {
        report();
        onChange();
      }
    }),
    placeholder(hint),
    language === "sql" ? sql({ dialect: cosmosDialect }) : json(),
    ...(completion ? [autocompletion({ override: [completion] })] : []),
    ...(diagnostics
      ? [
          linter(
            (view) => {
              const text = view.state.doc.toString();
              const d =
                view.state.readOnly && !text.trim()
                  ? null
                  : jsonDiagnostic(text);
              return d ? [d] : [];
            },
            { delay: 200 },
          ),
        ]
      : []),
  ];
  const makeState = (doc) =>
    EditorState.create({
      doc,
      extensions: [
        ...extensions,
        access.of([
          EditorState.readOnly.of(locked),
          EditorView.editable.of(!locked),
        ]),
      ],
    });
  const view = new EditorView({ parent, state: makeState(value) });
  // Search also commits immediately after paste (the built-in panel listens
  // to keyup/change, which otherwise waits for focus to leave the input).
  parent.addEventListener("input", (event) => {
    if (event.target.matches?.('.cm-search input[name="search"]'))
      event.target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  parent.setAttribute("data-editor", "codemirror");
  parent.setAttribute("aria-readonly", String(locked));
  parent.append(status);
  updateStatus(view.state);
  report();
  return {
    get value() {
      return view.state.doc.toString();
    },
    set value(text) {
      // Loading a different document must discard its predecessor's undo history.
      view.setState(makeState(text));
      updateStatus(view.state);
      report();
    },
    get readOnly() {
      return locked;
    },
    set readOnly(value) {
      value = !!value;
      if (value === locked) return;
      locked = value;
      view.dispatch({
        effects: access.reconfigure([
          EditorState.readOnly.of(locked),
          EditorView.editable.of(!locked),
        ]),
      });
      parent.setAttribute("aria-readonly", String(locked));
      report();
    },
    onChange(fn) {
      onChange = fn;
    },
    search() {
      openSearchPanel(view);
      view.requestMeasure();
    },
    get nestedFoldCount() {
      return foldRanges().length;
    },
    get foldedCount() {
      return foldedRanges(view.state).size;
    },
    fold() {
      const ranges = foldRanges();
      unfoldAll(view);
      if (ranges.length)
        view.dispatch({ effects: ranges.map((range) => foldEffect.of(range)) });
    },
    unfold() {
      unfoldAll(view);
    },
    measure() {
      view.requestMeasure();
    },
    focusError() {
      if (!lastDiagnostic) return;
      const pos = lastDiagnostic.from;
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
      view.focus();
    },
    format() {
      if (locked) return;
      const text = view.state.doc.toString();
      if (!text.trim()) return;
      const error = jsonDiagnostic(text);
      if (error) {
        lastDiagnostic = error;
        diagnostics?.(error);
        this.focusError();
        return;
      }
      const formatted = formatJSON(text);
      if (formatted === text) return;
      view.dispatch({
        changes: { from: 0, to: text.length, insert: formatted },
        annotations: [
          Transaction.userEvent.of("input.format"),
          isolateHistory.of("full"),
        ],
      });
    },
  };
}
