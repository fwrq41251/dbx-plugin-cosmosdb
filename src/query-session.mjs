import { validateSQLExecution, sqlErrorDiagnostic } from "./sql-execution.mjs";
import { parseArray, parseJSON } from "./model.mjs";
import { hasRootProjection } from "./sql-completion.mjs";
import {
  t,
  message as msg,
  LocalizedError,
  renderMessage,
  setText,
} from "./i18n.mjs";

export function createQueryState() {
  return { pages: [], page: -1, queryJob: null, resultStale: false };
}

export function createQueryController(dependencies) {
  const {
    state,
    queryState,
    sqlEditor,
    $,
    discard,
    scope,
    invoke,
    clearSQLError,
    renderResultSummary,
    status,
    controls,
    renderPage,
    resetEditor,
    clearStatus,
    rememberKey,
    learnPartitionKeys,
    knownFields,
    host,
    hideQueryStatus,
  } = dependencies;
  async function query(next = false) {
    const execution = next
      ? queryState.pages[queryState.page]?.execution
      : sqlEditor.execution;
    if (!next) validateSQLExecution(execution);
    if (!(await discard())) return;
    let spec;
    if (next) {
      const p = queryState.pages[queryState.page];
      if (!p?.continuation) return;
      spec = { ...p.spec, continuation: p.continuation };
    } else {
      parseArray($("parameters").value, msg("query.parameters"));
      if ($("query-pk").value.trim())
        parseArray($("query-pk").value, msg("partition.key"));
      spec = {
        ...scope(),
        query: execution.query,
        parametersText: $("parameters").value,
        partitionKeyText: $("query-pk").value.trim(),
        pageSize: Number($("page-size").value),
      };
    }
    clearSQLError();
    const job = {
      id: crypto.randomUUID(),
      connectionId: state.connectionId,
      started: performance.now(),
      canceled: false,
    };
    queryState.queryJob = job;
    queryState.resultStale = true;
    renderResultSummary();
    const update = () =>
      status(
        msg("ui.runningQuerySAwaitingResultsRuUnknown", () => [
          ((performance.now() - job.started) / 1000).toFixed(1),
        ]),
      );
    update();
    job.timer = setInterval(update, 100);
    controls();
    let result;
    try {
      result = await invoke("cosmos/query", { ...spec, queryId: job.id });
      if (job.canceled || queryState.queryJob !== job) throw new Error("STALE");
    } catch (error) {
      if (job.canceled || error.message === "STALE") throw new Error("STALE");
      const elapsed = ((performance.now() - job.started) / 1000).toFixed(1);
      const diagnostic = sqlErrorDiagnostic(execution, sqlEditor.value, error);
      const syntaxError =
        error.data?.category === "sql-syntax" ||
        /HTTP 400: SQL 语法错误/.test(error.message || "");
      if (syntaxError) {
        sqlEditor.setDiagnostic(diagnostic);
        setText($("sql-error-message"), () =>
          diagnostic
            ? renderMessage(diagnostic.message).replace(
                t("ui.clickToLocate"),
                "",
              )
            : renderMessage(error).replace(/^HTTP 400:\s*/, ""),
        );
        setText($("sql-error-meta"), () => t("ui.sRuUnknown", () => [elapsed]));
        $("sql-diagnostic").hidden = !diagnostic;
        $("sql-error").hidden = false;
        hideQueryStatus();
        return;
      }
      throw new LocalizedError(
        msg("ui.queryFailedSRuUnknown", () => [elapsed, renderMessage(error)]),
      );
    } finally {
      clearInterval(job.timer);
      if (queryState.queryJob === job) queryState.queryJob = null;
    }
    rememberKey(spec.partitionKeyText || "");
    learnPartitionKeys(parseJSON(result.json));
    if (hasRootProjection(spec.query))
      for (const doc of parseJSON(result.json)) knownFields().learn(doc);
    if (!next) {
      queryState.pages = [];
      $("result-filter").value = "";
    } else queryState.pages = queryState.pages.slice(0, queryState.page + 1);
    queryState.resultStale = false;
    queryState.pages.push({ ...result, spec, execution });
    queryState.page = queryState.pages.length - 1;
    renderPage();
    resetEditor();
    clearStatus();
  }
  function cancelQuery() {
    const job = queryState.queryJob;
    if (!job) return;
    job.canceled = true;
    clearInterval(job.timer);
    queryState.queryJob = null;
    ++state.operation;
    state.busy = false;
    controls();
    const operation = state.operation;
    status(msg("ui.queryCanceledPreviousResultsRetainedConsumedRu"));
    void host
      .invoke(
        "cosmos/cancel",
        { connectionId: job.connectionId, queryId: job.id },
        { timeoutMs: 10000 },
      )
      .catch(() => {
        if (
          state.operation === operation &&
          state.connectionId === job.connectionId
        )
          status(
            msg("ui.stoppedReceivingQueryResultsBackendCancellationIs"),
            true,
          );
      });
  }
  return { query, cancelQuery };
}
