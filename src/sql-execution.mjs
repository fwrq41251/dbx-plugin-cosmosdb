import { t, message as msg, LocalizedError } from "./i18n.mjs";
// CodeMirror and the bridge use zero-based string offsets. Preserve the exact
// submitted text, including leading whitespace, to map service diagnostics.
export function sqlExecution(document, selection) {
  const range = selection.main;
  const selected = !range.empty;
  const from = selected ? range.from : 0;
  const to = selected ? range.to : document.length;
  return {
    document,
    query: document.slice(from, to),
    from,
    to,
    selected,
    rangeCount: selection.ranges.length,
    startLine: document.slice(0, from).split("\n").length,
    endLine: document.slice(0, Math.max(from, to - 1)).split("\n").length,
  };
}

export function validateSQLExecution(execution) {
  if (execution.rangeCount > 1)
    throw new LocalizedError(msg("ui.keepOnlyOneSqlSelectionBeforeRunning"));
  if (!execution.query.trim())
    throw new LocalizedError(
      execution.selected
        ? msg("ui.selectedSqlIsBlankSelectSqlAgain")
        : msg("ui.enterSqlBeforeRunning"),
    );
}

export function sqlErrorDiagnostic(execution, currentDocument, error) {
  if (!execution || execution.document !== currentDocument) return null;
  let position;
  const data = error?.data;
  if (data?.status === 400 && data?.category === "sql-syntax") {
    position = data.position;
  } else if (!data) {
    // Older hosts may retain only our sanitized error message, not RPC data.
    const match = /HTTP 400: SQL 语法错误：第 (\d+) 个字符附近/.exec(
      error?.message || "",
    );
    if (match) position = Number(match[1]) - 1;
  }
  if (
    !Number.isInteger(position) ||
    position < 0 ||
    position > execution.query.length
  )
    return null;
  const from = execution.from + position;
  const prefix = currentDocument.slice(0, from).split("\n");
  const line = prefix.length,
    column = prefix.at(-1).length + 1;
  return {
    from,
    to: Math.min(from + 1, execution.to),
    severity: "error",
    get message() {
      return t("sql.syntaxLocation", () => [line, column]);
    },
  };
}
