import { t, setText, onLocaleChange, renderMessage } from "./i18n.mjs";
import { jsonStructure } from "./json-structure.mjs";
import { nestedJSONFolds } from "./json-folding.mjs";
import { minimalSetup } from "codemirror";
import {
  EditorState,
  Compartment,
  Transaction,
  EditorSelection,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder,
  lineNumbers,
  highlightActiveLineGutter,
  highlightActiveLine,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import { indentWithTab, isolateHistory } from "@codemirror/commands";
import { json, jsonLanguage } from "@codemirror/lang-json";
import { sql, SQLDialect } from "@codemirror/lang-sql";
import {
  linter,
  lintKeymap,
  setDiagnostics,
  setDiagnosticsEffect,
} from "@codemirror/lint";
import { sqlExecution } from "./sql-execution.mjs";
import {
  openSearchPanel,
  getSearchQuery,
  searchPanelOpen,
  highlightSelectionMatches,
  searchKeymap,
} from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  foldKeymap,
  foldEffect,
  foldedRanges,
  unfoldAll,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { parseJSON, formatJSON } from "./model.mjs";

const phrases = () => ({
  Find: t("editor.find"),
  Replace: t("editor.replace"),
  next: t("editor.nextMatch"),
  previous: t("editor.previousMatch"),
  all: t("editor.all"),
  "match case": t("editor.matchCase"),
  "by word": t("editor.wholeWord"),
  regexp: t("editor.regexp"),
  replace: t("editor.replace"),
  "replace all": t("editor.replaceAll"),
  close: t("common.close"),
  "No diagnostics": t("editor.noDiagnostics"),
  "Fold line": t("editor.foldLine"),
  "Unfold line": t("editor.unfoldLine"),
  to: t("editor.to"),
  "on line": t("editor.onLine"),
});
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
      get message() {
        return t("json.invalidLocation", () => [line, column]);
      },
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
    contextMenu,
  } = {},
) {
  const access = new Compartment();
  const localization = new Compartment();
  let locked = readOnly,
    onChange = () => {},
    onSelection = () => {},
    lastDiagnostic;
  const status = document.createElement("div");
  status.className = "editor-status";
  let previousSearchOpen,
    previousQuery,
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
    const searchOpen = searchPanelOpen(state);
    if (
      query !== previousQuery ||
      state.doc !== previousDoc ||
      searchOpen !== previousSearchOpen
    ) {
      previousSearchOpen = searchOpen;
      previousQuery = query;
      previousDoc = state.doc;
      matches = [];
      capped = false;
      if (searchOpen && query.valid) {
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
    setText(
      status,
      () =>
        t("editor.position", () => [
          line.number,
          selection.head - line.from + 1,
          state.readOnly ? t("ui.readOnly") : "",
          count ? t("ui.folds", () => [count]) : "",
        ]) +
        (searchOpen && query.search
          ? t("ui.matches", () => [
              current >= 0 ? `${current + 1} / ` : "",
              matches.length,
              capped ? "+" : "",
            ])
          : "") +
        (language === "sql" && !selection.empty
          ? t("ui.charactersSelectedRunSelection", () => [
              selection.to - selection.from,
            ])
          : ""),
    );
  }
  const report = () => {
    if (!diagnostics) return;
    const text = view.state.doc.toString();
    lastDiagnostic = locked && !text.trim() ? null : jsonDiagnostic(text);
    diagnostics(lastDiagnostic);
  };
  const extensions = [
    ...(language === "sql"
      ? [
          minimalSetup,
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          keymap.of([...closeBracketsKeymap, ...completionKeymap]),
        ]
      : [
          keymap.of([
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...completionKeymap,
            ...lintKeymap,
          ]),
          minimalSetup,
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          dropCursor(),
          rectangularSelection(),
          crosshairCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightSelectionMatches(),
          jsonStructure(),
        ]),
    ...(language === "sql"
      ? [
          EditorState.transactionExtender.of((tr) =>
            tr.docChanged ? { effects: setDiagnosticsEffect.of([]) } : null,
          ),
        ]
      : []),
    localization.of([
      EditorState.phrases.of(phrases()),
      EditorView.contentAttributes.of({
        "aria-label": renderMessage(label),
        tabindex: "0",
        spellcheck: "false",
        autocapitalize: "off",
      }),
      placeholder(renderMessage(hint)),
    ]),
    keymap.of([indentWithTab]),
    EditorView.lineWrapping,
    syntaxHighlighting(highlight),
    EditorView.updateListener.of((update) => {
      updateStatus(update.state);
      if (update.docChanged) {
        if (language === "sql") lastDiagnostic = null;
        report();
        onChange();
      }
      if (update.docChanged || update.selectionSet) onSelection();
    }),
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
  onLocaleChange(() => {
    view.dispatch({
      effects: localization.reconfigure([
        EditorState.phrases.of(phrases()),
        EditorView.contentAttributes.of({
          "aria-label": renderMessage(label),
          tabindex: "0",
          spellcheck: "false",
          autocapitalize: "off",
        }),
        placeholder(renderMessage(hint)),
      ]),
    });
    if (lastDiagnostic) {
      view.dispatch(setDiagnostics(view.state, [lastDiagnostic]));
    }
    updateStatus(view.state);
    report();
  });
  if (contextMenu) {
    // Capture before CodeMirror widgets (fold placeholders ignore normal events).
    parent.addEventListener(
      "contextmenu",
      (event) => {
        if (!view.contentDOM.contains(event.target)) return;
        const widget = event.target.closest?.(".cm-foldPlaceholder");
        const position = widget
          ? view.posAtDOM(widget)
          : view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return;
        let to = position;
        if (widget)
          foldedRanges(view.state).between(position, position, (from, end) => {
            if (from === position) to = end;
          });
        if (contextMenu({ position, to, x: event.clientX, y: event.clientY })) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true,
    );
    parent.addEventListener(
      "keydown",
      (event) => {
        if (
          !view.contentDOM.contains(event.target) ||
          !(
            event.key === "ContextMenu" ||
            (event.key === "F10" && event.shiftKey)
          )
        )
          return;
        const selection = view.state.selection.main;
        const position = selection.empty ? selection.head : selection.from;
        const rect =
          view.coordsAtPos(position) || view.dom.getBoundingClientRect();
        if (contextMenu({ position, x: rect.left, y: rect.bottom })) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true,
    );
  }
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
      if (language === "sql") lastDiagnostic = null;
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
    onSelection(fn) {
      onSelection = fn;
    },
    get execution() {
      return sqlExecution(view.state.doc.toString(), view.state.selection);
    },
    setDiagnostic(diagnostic) {
      lastDiagnostic = diagnostic;
      view.dispatch(setDiagnostics(view.state, diagnostic ? [diagnostic] : []));
      if (diagnostic)
        view.dispatch({
          effects: EditorView.scrollIntoView(diagnostic.from, { y: "center" }),
        });
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
    focus() {
      view.focus();
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
