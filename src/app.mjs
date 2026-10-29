import { createQueryState, createQueryController } from "./query-session.mjs";
import {
  createDocumentState,
  createDocumentController,
} from "./document-session.mjs";
import { createScopeState, createScopeController } from "./scope-session.mjs";
import {
  t,
  setText,
  setAttr,
  setLocale,
  localizeStaticDOM,
  renderMessage,
  serviceMessage,
  message as msg,
  LocalizedError,
} from "./i18n.mjs";
import { icon } from "./icons.mjs";
import { createMenu } from "./menu.mjs";
import { jsonResultItems, jsonResultItemAt } from "./result-items.mjs";
import { createCodeEditor } from "./code-editor.mjs";
import {
  sqlParameterNames,
  KnownFields,
  sqlCompletions,
} from "./sql-completion.mjs";
import {
  keyFromDocument,
  parseArray,
  columnsFor,
  formatJSON,
  parseJSON,
  encodeJSON,
} from "./model.mjs";
import { PartitionCandidates, PartitionLoader } from "./partitions.mjs";
import {
  cellText,
  tablePreferences,
  tableColumns,
  rowIdentity,
} from "./results.mjs";
import {
  editableDocument,
  applyDocumentPartition,
  newDocument,
  documentChanges,
} from "./documents.mjs";
import {
  documentFields,
  parseFieldInput,
  editDocumentField,
  documentPathExists,
} from "./fields.mjs";
const $ = (id) => document.getElementById(id);
const state = {
  connectionId: "",
  connectionName: "",
  readOnly: true,
  busy: false,
  epoch: 0,
  resultView: "table",
  documentView: "json",
  preferredDocumentView: "fields",
  operation: 0,
  tablePrefs: tablePreferences(),
  tableRevision: 0,
  selectedCell: null,
  selectedRow: null,
};
const queryState = createQueryState();
const documentState = createDocumentState();
const scopeState = createScopeState();
const host = window.dbxPlugin;
localizeStaticDOM(document.body);
const syncLocale = () => setLocale(host?.locale || "en");
if (host)
  host.onEvent((event) => {
    if (event.type === "env") syncLocale();
  });

let copyMenu, documentWriteMenu;
let viewPreferenceWrites = Promise.resolve(),
  viewPreferenceRevision = 0;
let resultEditor = null,
  resultEditorPage,
  resultEditorFilter = "";
let resultItemContext = null,
  resultItemText = "",
  resultItemRanges = [];

const fieldScopes = new Map();
function knownFields() {
  const key = partitionScope();
  if (!fieldScopes.has(key)) {
    if (fieldScopes.size >= 30)
      fieldScopes.delete(fieldScopes.keys().next().value);
    fieldScopes.set(key, new KnownFields());
  }
  return fieldScopes.get(key);
}
let documentError = null;
const documentEditor = createCodeEditor($("editor"), {
  label: msg("document.jsonLabel"),
  readOnly: true,
  hint: msg("ui.previewAResultRowOrOpenA"),
  diagnostics(error) {
    documentError = error;
    $("json-diagnostic").hidden = !error || state.documentView !== "json";
    setText($("json-diagnostic"), () => renderMessage(error?.message || ""));
  },
});
const sqlEditor = createCodeEditor($("sql"), {
  label: msg("query.title"),
  language: "sql",
  value: "SELECT * FROM c",
  completion(context) {
    let parameters = [];
    try {
      parameters = parseArray($("parameters").value, msg("query.parameters"))
        .map((x) => x?.name)
        .filter((x) => typeof x === "string");
    } catch {}
    return sqlCompletions(context.state.doc.toString(), context.pos, {
      fields: knownFields(),
      parameters,
      explicit: context.explicit,
    });
  },
});
function hideQueryStatus() {
  clearTimeout(statusTimer);
  $("status").hidden = true;
}
const { query, cancelQuery } = createQueryController({
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
});
const { listAll, loadDatabases, selectDatabase, selectContainer } =
  createScopeController({
    scopeState,
    $,
    invoke,
    options,
    activatePartitionScope,
    resetResults,
    updateScopeContext,
    status,
    loadTablePreferences,
  });
const { point, opened, saveDocument, deleteDocument } =
  createDocumentController({
    documentState,
    state,
    $,
    documentEditor,
    scope,
    partitionPaths,
    showDocument,
    knownFields,
    rememberKey,
    metrics,
    setDocumentView,
    status,
    confirmAction,
    pauseDiscovery,
    invoke,
    afterMutation,
    dirty,
    resetEditor,
  });
const partitionScopes = new Map();
let partitionTarget = "query-pk",
  partitionFilter = "",
  partitionActiveKey = null,
  partitionPickerEpoch = 0,
  partitionBrowseRequested = false;
function partitionScope() {
  return JSON.stringify([
    state.connectionId,
    scopeState.database,
    scopeState.container,
  ]);
}
function candidates() {
  const key = partitionScope();
  if (!partitionScopes.has(key))
    partitionScopes.set(key, new PartitionCandidates());
  return partitionScopes.get(key);
}
function partitionPaths() {
  return (
    scopeState.containers.find((x) => x.id === scopeState.container)
      ?.partitionKey?.paths || []
  );
}
function rememberKey(text) {
  if (!scopeState.container || !text.trim()) return;
  try {
    candidates().add(text);
  } catch {
    /* Invalid manual input is validated when it is used. */
  }
}
function closePartitionPicker() {
  partitionPickerEpoch++;
  partitionActiveKey = null;
  for (const id of ["query-pk", "document-pk"]) {
    $(id).setAttribute("aria-expanded", "false");
    $(id).removeAttribute("aria-activedescendant");
  }
  if (scopeState.container) candidates().loader?.stop();
  $("pk-picker").hidden = true;
  for (const id of ["query-pk-choose", "document-pk-choose"])
    $(id).setAttribute("aria-expanded", "false");
}
function activatePartitionScope() {
  for (const cache of partitionScopes.values()) cache.loader?.stop();
  closePartitionPicker();
  $("query-pk").value = scopeState.container ? candidates().selected || "" : "";
}
function renderPartitionOptions() {
  const cache = candidates(),
    items = cache.filter(partitionFilter),
    target = $("pk-options");
  target.replaceChildren();
  let selected = "";
  try {
    selected = encodeJSON(
      parseArray($(partitionTarget).value, msg("partition.key")),
    );
  } catch {}
  setText($("pk-count"), () =>
    t("ui.matchingKnownKeys", () => [items.length, cache.keys.size]),
  );
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    setText(empty, () =>
      cache.keys.size
        ? t("ui.noMatchesYetWaitForLoadingOr")
        : cache.loader?.error
          ? t("ui.cannotLoadKeysAutomaticallyYouCanStill")
          : !cache.hydrated
            ? t("ui.readingLocalKeys")
            : t("ui.noLocalKeysEnterAJsonPartition"),
    );
    target.append(empty);
  }
  for (const [index, item] of items.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "option");
    button.id = `pk-option-${index}`;
    button.tabIndex = -1;
    button.classList.toggle("keyboard-active", item.key === partitionActiveKey);
    button.onpointerdown = (event) => event.preventDefault();
    button.setAttribute("aria-selected", String(selected === item.key));
    button.disabled = state.busy;
    button.dataset.key = item.key;
    const label = document.createElement("span");
    setText(label, () => item.label);
    const json = document.createElement("code");
    json.textContent = item.key;
    button.append(label, json);
    button.onclick = () => {
      if (state.busy) return;
      $(partitionTarget).value = item.key;
      renderResultSummary();
      if (partitionTarget === "query-pk") cache.selected = item.key;
      else if (documentState.creating) syncDraftPartition();
      closePartitionPicker();
      $(partitionTarget).focus();
    };
    target.append(button);
  }
  const active = [...target.querySelectorAll("button")].find(
    (b) => b.dataset.key === partitionActiveKey,
  );
  if (active)
    $(partitionTarget).setAttribute("aria-activedescendant", active.id);
  else {
    partitionActiveKey = null;
    $(partitionTarget).removeAttribute("aria-activedescendant");
  }
  const loader = cache.loader,
    stats = cache.stats.seek,
    done = stats.started && !stats.continuation;
  const loadLabel = done
    ? msg("ui.allLoaded")
    : loader?.running
      ? msg("ui.pauseLoading")
      : msg("ui.resumeLoading");
  $("pk-load").innerHTML = icon(loader?.running ? "pause" : "play");
  $("pk-load").classList.add("icon-button");
  setAttr($("pk-load"), "title", () => renderMessage(loadLabel));
  setAttr($("pk-load"), "aria-label", () => renderMessage(loadLabel));
  $("pk-load").disabled = state.busy || done || !scopeState.container;
  $("pk-load").hidden = done;
  $("pk-reload").disabled =
    state.busy || !!loader?.task || !scopeState.container;
  $("pk-clear").disabled = state.busy;
  const ru = Object.values(cache.stats).reduce((sum, s) => sum + s.ru, 0);
  setText($("pk-progress"), () =>
    [
      renderMessage(loader?.error || loader?.notice),
      done
        ? t("ui.allPartitionKeysLoadedKeys", () => [cache.keys.size])
        : loader?.running
          ? t("ui.loadingKeysFoundMoreRemaining", () => [cache.keys.size])
          : t("ui.localKeysOpenTheDropdownToLoad"),
      t("ui.thisSessionRu", () => [ru.toFixed(2)]),
      cache.cachedAt
        ? t("ui.localCache", () => [new Date(cache.cachedAt).toLocaleString()])
        : "",
      renderMessage(cache.cacheWarning),
    ]
      .filter(Boolean)
      .join(" · "),
  );
  $("pk-progress").classList.toggle("error", !!loader?.error);
  if (!$("pk-picker").hidden) positionPartitionPicker();
}
function positionPartitionPicker() {
  const rect = $(partitionTarget).getBoundingClientRect(),
    picker = $("pk-picker");
  picker.style.width = `${Math.min(Math.max(rect.width + 28, 300), 600, innerWidth - 16)}px`;
  const below = innerHeight - rect.bottom - 12,
    above = rect.top - 12;
  const down = below >= Math.min(300, picker.scrollHeight) || below >= above;
  picker.style.maxHeight = `${Math.max(100, down ? below : above)}px`;
  const { width, height } = picker.getBoundingClientRect();
  picker.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
  picker.style.top = `${down ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`;
}
function openPartitionPicker(target, discover = true) {
  if (state.busy || !scopeState.container) return;
  if (partitionTarget !== target) closePartitionPicker();
  partitionTarget = target;
  partitionFilter = discover ? "" : $(target).value;
  partitionBrowseRequested = discover;
  partitionActiveKey = null;
  const generation = ++partitionPickerEpoch;
  $("pk-picker").hidden = false;
  $(target).setAttribute("aria-expanded", "true");
  $(target + "-choose").setAttribute("aria-expanded", "true");
  void startPartitionOptions(false, discover, generation);
  renderPartitionOptions();
  $(target).focus();
}
async function startPartitionOptions(
  refresh = false,
  discover = true,
  generation = partitionPickerEpoch,
) {
  const key = partitionScope(),
    identity = scope(),
    epoch = state.epoch;
  if (refresh) {
    const old = candidates();
    old.loader?.stop();
    const next = new PartitionCandidates();
    next.selected = old.selected;
    partitionScopes.set(key, next);
  }
  const cache = candidates();
  if (!cache.hydrated && !refresh) {
    if (!cache.hydrating)
      cache.hydrating = (async () => {
        try {
          const saved = await invoke("cosmos/partitionCache", identity);
          if (saved.found) {
            for (const value of saved.keys) cache.add(value);
            cache.stats.seek.started = saved.complete || !!saved.continuation;
            cache.stats.seek.continuation = saved.continuation || "";
            cache.cachedAt = saved.updatedAt;
          }
        } catch (error) {
          if (error.message !== "STALE")
            cache.cacheWarning = msg(
              "ui.localCacheUnavailableReloadingFromTheIndex",
            );
        }
        cache.hydrated = true;
      })();
    await cache.hydrating;
  }
  cache.hydrated = true;
  if (
    key !== partitionScope() ||
    epoch !== state.epoch ||
    candidates() !== cache
  )
    return;
  if (!cache.loader)
    cache.loader = new PartitionLoader(
      cache,
      "seek",
      async (mode, continuation) => {
        if (epoch !== state.epoch || key !== partitionScope())
          throw new Error("STALE");
        return invoke("cosmos/partitionKeys", {
          ...identity,
          discoveryMode: mode,
          continuation,
          pageSize: 1,
        });
      },
      () => {
        if (
          key === partitionScope() &&
          candidates() === cache &&
          !$("pk-picker").hidden
        )
          renderPartitionOptions();
      },
    );
  // The loader handles errors without blocking query inputs or candidate selection.
  if (!$("pk-picker").hidden && generation === partitionPickerEpoch) {
    renderPartitionOptions();
    if (discover) void cache.loader.start();
  }
}
function learnPartitionKeys(rows) {
  const paths = partitionPaths();
  for (const row of rows) {
    const complete = paths.every((path) => {
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
          return false;
        value = value[part];
      }
      return true;
    });
    if (complete) rememberKey(keyFromDocument(row, paths));
  }
}
$("confirm-cancel").onclick = () => $("confirm-dialog").close("cancel");
$("confirm-accept").onclick = () => $("confirm-dialog").close("confirm");
let statusTimer;
function status(text, error = false) {
  clearTimeout(statusTimer);
  $("status").hidden = false;
  $("status").classList.toggle("progress", !!queryState.queryJob);
  if (!error && !queryState.queryJob)
    statusTimer = setTimeout(() => {
      $("status").hidden = true;
    }, 4000);
  setText($("status"), () => renderMessage(text));
  setAttr($("status"), "title", () => "");
  $("status").classList.toggle("error", error);
}
function dirty() {
  return (
    !state.readOnly &&
    !!(documentState.snapshot || documentState.creating) &&
    (documentEditor.value !== documentState.baseline ||
      documentState.fieldErrors.size > 0)
  );
}
function confirmAction(title, message, changes = []) {
  status(msg("ui.awaitingConfirmation2", () => [renderMessage(title)]));
  setText($("confirm-title"), () => renderMessage(title));
  setText($("confirm-message"), () => renderMessage(message));
  const rows = $("change-rows");
  rows.replaceChildren();
  $("confirm-changes").hidden = !changes.length;
  $("confirm-dialog").classList.toggle("has-changes", !!changes.length);
  setText($("change-count"), () =>
    t("ui.fieldChanges", () => [
      changes.length,
      changes.length > 200 ? t("ui.showingTheFirst") : "",
    ]),
  );
  for (const change of changes.slice(0, 200)) {
    const tr = document.createElement("tr");
    for (const [column, value] of [
      change.path,
      change.before,
      change.after,
    ].entries()) {
      const td = document.createElement("td");
      setText(td, () => {
        if (column === 1 && change.kind === "add") return t("diff.missing");
        if (column === 2 && change.kind === "remove") return t("diff.deleted");
        return value;
      });
      tr.append(td);
    }
    rows.append(tr);
  }
  return new Promise((resolve) => {
    const d = $("confirm-dialog");
    d.returnValue = "cancel";
    d.addEventListener(
      "close",
      () => {
        const confirmed = d.returnValue === "confirm";
        if (!confirmed) status(msg("ui.operationCanceled"));
        resolve(confirmed);
      },
      { once: true },
    );
    d.showModal();
    d.focus();
  });
}
async function discard() {
  return (
    !dirty() ||
    (await confirmAction(
      msg("ui.discardUnsavedChanges"),
      msg("ui.thisWillReplaceTheCurrentDocumentDraft"),
    ))
  );
}
function controls() {
  const ready = !!state.connectionId,
    selected = !!scopeState.container,
    busy = state.busy;
  for (const id of [
    "refresh",
    "database",
    "container",
    "query-pk",
    "page-size",
    "parameters",
    "scope-database",
    "scope-container",
    "document-id",
    "document-pk",
  ])
    $(id).disabled = busy || !ready;
  for (const id of ["run", "read", "new"]) $(id).disabled = busy || !selected;
  sqlEditor.readOnly = busy || !ready;
  documentEditor.readOnly =
    busy ||
    state.readOnly ||
    (!documentState.snapshot && !documentState.creating);
  $("scope-container").disabled = busy || !ready || !scopeState.database;
  $("scope-info").disabled = busy || !scopeState.container;
  $("document-search").disabled =
    busy || !documentEditor.value.trim() || documentState.fieldErrors.size > 0;
  $("document-more").disabled = busy || !documentEditor.value.trim();
  if (busy) {
    closePartitionPicker();
    copyMenu?.close();
    documentWriteMenu?.close();
    closeDocumentMenu();
    closeResultItemMenu();
    closeScopePicker();
  }
  documentActions();
  $("document-format").disabled =
    busy ||
    state.readOnly ||
    (!documentState.snapshot && !documentState.creating);
  $("previous").disabled = busy || queryState.page <= 0;
  $("next").disabled = busy || !queryState.pages[queryState.page]?.continuation;
  $("export").disabled = busy || queryState.page < 0;
  $("result-filter").disabled = busy || queryState.page < 0;
  $("copy-cell").disabled = busy || state.selectedCell === null;
  $("copy-row").disabled = busy || state.selectedRow === null;
  $("copy-selection").disabled =
    busy || (state.selectedCell === null && state.selectedRow === null);
  $("result-tools").hidden = queryState.page < 0;
  for (const id of ["table-view", "json-view"]) $(id).disabled = busy || !ready;
  resultReaderControls();
  updateFieldChanges();
  $("cancel-query").hidden = !queryState.queryJob;
  $("save").disabled =
    busy ||
    state.readOnly ||
    (!documentState.snapshot && !documentState.creating) ||
    (!!documentState.snapshot && !dirty()) ||
    documentState.fieldErrors.size > 0 ||
    !!documentError;
  $("delete").disabled = busy || state.readOnly || !documentState.snapshot;
  $("new").disabled ||= state.readOnly;
  $("generate-id").hidden = !documentState.creating;
  $("replace-document").hidden = !documentState.snapshot;
  $("replace-document").disabled =
    $("save").disabled || !documentState.snapshot;
  $("document-actions").hidden =
    state.readOnly ||
    (!documentState.creating && (!documentState.snapshot || !dirty()));
  $("document-actions").disabled = busy;
  $("generate-id").disabled = busy || state.readOnly || !documentState.creating;
  setText($("write-hint"), () =>
    state.readOnly
      ? t("ui.thisConnectionIsReadOnlyUseWritable")
      : documentState.creating
        ? t("ui.currentPartitionKeyAppliedEditTheId")
        : t("ui.readTheFullDocumentToUpdateOr"),
  );
  for (const id of ["fields-view", "document-json-view", "field-filter"])
    $(id).disabled = busy || !ready;
  for (const el of $("field-list").querySelectorAll(
    "input,textarea,select,button",
  ))
    el.disabled =
      busy ||
      state.readOnly ||
      (!documentState.snapshot && !documentState.creating) ||
      el.dataset.locked === "true";
  for (const id of ["add-field", "add-field-path", "add-field-value"])
    $(id).disabled =
      busy ||
      state.readOnly ||
      (!documentState.snapshot && !documentState.creating);
  for (const id of ["query-pk-choose", "document-pk-choose"])
    $(id).disabled = busy || !selected;
  if (!$("pk-picker").hidden) renderPartitionOptions();
  for (const el of $("table").querySelectorAll(".row-read"))
    el.disabled = busy || el.dataset.available !== "true";
}
async function action(fn) {
  if (state.busy) return;
  const epoch = state.epoch;
  const operation = ++state.operation;
  state.busy = true;
  controls();
  status(msg("ui.working"));
  try {
    await fn();
  } catch (error) {
    if (
      epoch === state.epoch &&
      operation === state.operation &&
      error?.message !== "STALE"
    )
      status(error, true);
  } finally {
    if (epoch === state.epoch && operation === state.operation) {
      state.busy = false;
      controls();
    }
  }
}
async function invoke(method, params = {}) {
  const epoch = state.epoch;
  const result = await host.invoke(
    method,
    { connectionId: state.connectionId, ...params },
    { timeoutMs: 60000 },
  );
  if (epoch !== state.epoch) throw new Error("STALE");
  for (const kind of ["cacheWarning", "scopeWarning"])
    if (result?.[kind + "Detail"])
      result[kind] = serviceMessage(result[kind + "Detail"], result[kind]);
  return result;
}
function scope() {
  if (!scopeState.database || !scopeState.container)
    throw new LocalizedError(msg("ui.selectADatabaseAndContainerFirst"));
  return { database: scopeState.database, container: scopeState.container };
}
function clearStatus() {
  clearTimeout(statusTimer);
  $("status").hidden = true;
  setText($("status"), () => "");
  $("status").classList.remove("progress", "error");
}
function metrics(result, prefix = "") {
  status(
    msg("common.metrics", () => [
      renderMessage(prefix),
      result.ru.toFixed(2),
      result.durationMs,
    ]),
  );
  setAttr($("status"), "title", () =>
    result.activityId ? `Activity ID: ${result.activityId}` : "",
  );
}
function resetEditor() {
  hideDocument();
  documentWriteMenu?.close();
  closeDocumentMenu();
  $("document-location").open = true;
  setText($("document-identity"), () => t("ui.readByIdAndPartitionKey"));
  setAttr($("document-identity"), "title", () => "");
  documentState.fieldErrors.clear();
  documentState.snapshot = null;
  documentState.creating = false;
  documentState.baseline = "";
  documentEditor.value = "";
  $("document-id").value = "";
  $("document-pk").value = "";
  setText($("document-state"), () => t("document.notSelected"));
  setText($("etag"), () => t("ui.readTheFullDocumentBeforeUpdatingOr"));
  $("field-list").replaceChildren();
  setDocumentView("json");
}
function resetResults() {
  clearSQLError();
  queryState.resultStale = false;
  state.selectedCell = null;
  state.selectedRow = null;
  $("result-filter").value = "";
  queryState.pages = [];
  queryState.page = -1;
  renderPage();
  resetEditor();
}
function options(id, items, placeholder) {
  const el = $(id);
  const prompt = new Option("", "");
  setText(prompt, () => renderMessage(placeholder));
  el.replaceChildren(prompt);
  for (const item of items) el.add(new Option(item.id, item.id));
  setAttr(el, "title", () => el.selectedOptions[0]?.textContent || "");
}

async function loadViewPreferences() {
  const revision = viewPreferenceRevision;
  const epoch = state.epoch;
  try {
    await viewPreferenceWrites;
    const saved = await invoke("cosmos/viewPreferences");
    if (epoch !== state.epoch || revision !== viewPreferenceRevision) return;
    state.preferredDocumentView = saved.document === "json" ? "json" : "fields";
    view(saved.results === "json", false);
  } catch (error) {
    if (epoch === state.epoch && error.message !== "STALE")
      status(msg("ui.viewPreferencesUnavailableYouCanStillChange"));
  }
}
function saveViewPreference(views) {
  ++viewPreferenceRevision;
  viewPreferenceWrites = viewPreferenceWrites
    .catch(() => {})
    .then(async () => {
      await host.invoke(
        "cosmos/viewPreferences",
        { views },
        { timeoutMs: 10000 },
      );
    })
    .catch(() => status(msg("ui.couldNotSaveTheViewPreferenceYour"), true));
}
let preferenceWrites = Promise.resolve();
function preferenceKey() {
  return `table-v1:${partitionScope()}`;
}
async function loadTablePreferences() {
  const key = preferenceKey(),
    revision = ++state.tableRevision;
  state.tablePrefs = tablePreferences();
  try {
    const value = await invoke("cosmos/tablePreferences", scope());
    if (key !== preferenceKey() || revision !== state.tableRevision) return;
    state.tablePrefs = tablePreferences(value);
    renderPage();
  } catch {
    if (key === preferenceKey())
      status(msg("ui.columnWidthsApplyToThisSessionOnly"));
  }
}
function saveTablePreferences() {
  ++state.tableRevision;
  const key = preferenceKey(),
    value = JSON.parse(JSON.stringify(state.tablePrefs));
  const params = {
    connectionId: state.connectionId,
    ...scope(),
    preferences: value,
  };
  preferenceWrites = preferenceWrites
    .catch(() => {})
    .then(async () => {
      await host.invoke("cosmos/tablePreferences", params, {
        timeoutMs: 10000,
      });
    })
    .catch(() => {
      if (key === preferenceKey())
        status(msg("ui.couldNotSaveColumnWidthsCurrentWidths"), true);
    });
}
function pageRows() {
  const p = queryState.pages[queryState.page];
  const all = p ? parseJSON(p.json) : [];
  const filter = $("result-filter").value.trim().toLowerCase();
  return {
    all,
    filter,
    rows: all
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) => !filter || encodeJSON(row).toLowerCase().includes(filter),
      ),
  };
}
function resultReaderControls() {
  const unavailable = state.busy || queryState.page < 0 || !resultEditor;
  $("result-json-search").disabled = unavailable;
  $("copy-results-json").disabled = unavailable;
  setAttr($("copy-results-json"), "title", () =>
    $("result-filter").value.trim()
      ? t("ui.copyFilteredPageJsonAllFields")
      : t("ui.copyEntirePageJsonAllFields"),
  );
  setAttr(
    $("copy-results-json"),
    "aria-label",
    () => $("copy-results-json").title,
  );
}
function syncResultReader(source) {
  const page = queryState.pages[queryState.page],
    filter = $("result-filter").value.trim().toLowerCase();
  if ($("raw-results").hidden) {
    // Do not format or create another editor while the table is in use. If a
    // reader already exists, discard obsolete data and undo/search/fold state.
    if (
      resultEditor &&
      (resultEditorPage !== page || resultEditorFilter !== filter) &&
      resultEditor.value
    ) {
      clearResultItemIndex();
      resultEditor.value = "";
      resultEditorPage = undefined;
      resultEditorFilter = "";
    }
    return;
  }
  if (!resultEditor) {
    resultEditor = createCodeEditor($("raw-results"), {
      label: msg("results.jsonLabel"),
      readOnly: true,
      hint: msg("ui.runAQueryToViewPageJson"),
      contextMenu: openResultItemMenu,
    });
  }
  if (resultEditorPage !== page || resultEditorFilter !== filter) {
    clearResultItemIndex();
    const rows = source?.rows || pageRows().rows;
    resultEditor.value = page
      ? filter
        ? encodeJSON(
            rows.map((x) => x.row),
            null,
            2,
          )
        : formatJSON(page.json)
      : "";
    resultEditorPage = page;
    resultEditorFilter = filter;
  }
  resultEditor.measure();
  resultReaderControls();
}
function clearResultItemIndex() {
  closeResultItemMenu();
  resultItemText = "";
  resultItemRanges = [];
}
function currentResultItem(context) {
  return (
    !!context &&
    context.epoch === state.epoch &&
    context.page === queryState.pages[queryState.page] &&
    context.filter === $("result-filter").value.trim().toLowerCase() &&
    context.target.connectionId === state.connectionId &&
    context.target.database === scopeState.database &&
    context.target.container === scopeState.container &&
    resultEditorPage === context.page &&
    resultEditorFilter === context.filter &&
    !$("raw-results").hidden
  );
}
function closeResultItemMenu(focus = false) {
  $("result-item-menu").hidden = true;
  resultItemContext = null;
  if (focus && !$("raw-results").hidden) resultEditor?.focus();
}
function openResultItemMenu({ position, to = position, x, y }) {
  closeResultItemMenu();
  const page = queryState.pages[queryState.page];
  if (state.busy || !page || !resultEditor || $("raw-results").hidden)
    return false;
  const text = resultEditor.value;
  if (text !== resultItemText) {
    resultItemRanges = jsonResultItems(text);
    resultItemText = text;
  }
  const item = jsonResultItemAt(resultItemRanges, position);
  if (!item || to > item.to) return false;
  const json = text.slice(item.from, item.to),
    row = parseJSON(json);
  const paths = partitionPaths(),
    identity = rowIdentity(row, paths);
  const filter = $("result-filter").value.trim().toLowerCase();
  resultItemContext = {
    page,
    filter,
    epoch: state.epoch,
    json,
    identity,
    index: item.index,
    target: { connectionId: state.connectionId, ...scope() },
  };
  setText($("result-item-summary"), () =>
    t("ui.itemQueryProjection", () => [
      filter ? t("ui.filteredResults") : t("results.currentPage"),
      item.index + 1,
    ]),
  );
  $("read-result-item").disabled = !identity;
  setText($("result-item-hint"), () =>
    identity
      ? t("ui.copiesTheQueryProjectionOpeningReadsThe")
      : paths.length
        ? t("ui.missingAStringIdOrCompletePartition", () => [paths.join(", ")])
        : t("ui.containerPartitionPathsUnavailableCannotOpenThe"),
  );
  const menu = $("result-item-menu");
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  $("copy-result-item").focus();
  return true;
}
$("copy-result-item").onclick = () => {
  const context = resultItemContext;
  if (state.busy || !currentResultItem(context)) {
    closeResultItemMenu();
    return;
  }
  closeResultItemMenu(true);
  void copyResult(
    context.json,
    msg("ui.itemJsonQueryProjection", () => [context.index + 1]),
  );
};
$("read-result-item").onclick = () => {
  const context = resultItemContext;
  if (state.busy || !context?.identity || !currentResultItem(context)) {
    closeResultItemMenu();
    return;
  }
  closeResultItemMenu();
  void action(async () => {
    if (!(await discard())) {
      if (currentResultItem(context)) resultEditor.focus();
      return;
    }
    if (!currentResultItem(context)) return;
    const target = { ...context.target, ...context.identity };
    const result = await invoke("cosmos/read", target);
    showDocument();
    opened(result, target);
  });
};
$("result-item-menu").onkeydown = (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeResultItemMenu(true);
    return;
  }
  if (event.key === "Tab") {
    closeResultItemMenu(true);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = [
    ...$("result-item-menu").querySelectorAll("button:not(:disabled)"),
  ];
  const index = items.indexOf(document.activeElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
          items.length;
  items[next]?.focus();
};
document.addEventListener("pointerdown", (event) => {
  if (!$("result-item-menu").contains(event.target)) closeResultItemMenu();
});
document.addEventListener(
  "wheel",
  (event) => {
    if (!$("result-item-menu").contains(event.target)) closeResultItemMenu();
  },
  true,
);
window.addEventListener("resize", () => closeResultItemMenu());
function renderResultSummary() {
  const p = queryState.pages[queryState.page];
  setAttr($("query-metrics"), "title", () =>
    p?.activityId ? `Activity ID: ${p.activityId}` : "",
  );
  setText($("query-metrics"), () =>
    p ? `${p.ru.toFixed(2)} RU · ${p.durationMs} ms` : "",
  );
  const changed =
    p &&
    (p.spec.query !== sqlEditor.execution.query ||
      (p.execution?.selected && p.execution.document !== sqlEditor.value) ||
      p.spec.partitionKeyText !== $("query-pk").value.trim() ||
      p.spec.parametersText !== $("parameters").value ||
      p.spec.pageSize !== Number($("page-size").value));
  $("execution-source").hidden = !p?.execution?.selected;
  setText($("execution-source"), () =>
    p?.execution?.selected
      ? t("ui.selectedSqlLines", () => [
          p.execution.startLine,
          p.execution.endLine !== p.execution.startLine
            ? "–" + p.execution.endLine
            : "",
        ])
      : "",
  );
  $("result-origin").hidden = !p;
  setText($("result-origin"), () =>
    queryState.resultStale
      ? t("ui.showingPreviousQueryResults")
      : changed
        ? t("ui.queryConditionsChanged")
        : t("results.currentPage"),
  );
  $("result-origin").classList.toggle(
    "stale",
    queryState.resultStale || !!changed,
  );
  setAttr($("result-origin"), "title", () =>
    p
      ? t("ui.partitionKey", () => [
          p.spec.query,
          p.spec.partitionKeyText || t("partition.crossPartition"),
        ])
      : "",
  );
}
async function copyResult(text, label) {
  try {
    await host.request("host.copy", { text });
    status(msg("ui.copied", () => [renderMessage(label)]));
  } catch {
    status(msg("ui.copyFailedPleaseRetry"), true);
  }
}
function renderPage() {
  copyMenu?.close();
  const json = state.resultView === "json";
  $("table").hidden = json && queryState.page >= 0;
  $("raw-results").hidden = !json || queryState.page < 0;
  $("result-tools").hidden = queryState.page < 0;
  closeResultItemMenu();
  const p = queryState.pages[queryState.page];
  const { all: allRows, filter, rows } = pageRows();
  renderResultSummary();
  $("clear-filter").hidden = !filter;
  setAttr($("export"), "aria-label", () =>
    filter ? t("ui.exportFilteredResults") : t("ui.exportCurrentPage"),
  );
  setAttr($("export"), "title", () =>
    filter
      ? t("ui.exportMatchingDocumentsOnThisPageOnly")
      : t("ui.exportAllDocumentsOnThisPageAll"),
  );
  setText($("row-count"), () =>
    filter
      ? t("ui.rowsCurrentPageOnly", () => [rows.length, allRows.length])
      : t("results.rowCount", () => [allRows.length]),
  );
  setText($("page-label"), () =>
    t("results.page", () => [queryState.page + 1]),
  );
  syncResultReader({ page: p, filter, rows });
  const target = $("table");
  const scrollLeft = target.scrollLeft,
    scrollTop = target.scrollTop;
  const allColumns = columnsFor(allRows);
  state.selectedCell = null;
  state.selectedRow = null;
  $("copy-cell").disabled = true;
  $("copy-row").disabled = true;
  target.replaceChildren();
  if (!rows.length) {
    const el = document.createElement("div");
    el.className = "empty";
    setText(el, () =>
      !p
        ? scopeState.container
          ? t("ui.runAQueryToViewResults")
          : t("ui.selectAContainerThenRunAQuery")
        : filter && allRows.length
          ? t("ui.noMatchesOnThisPageClearThe", () => [
              p.continuation ? t("ui.orViewTheNextPage") : "",
            ])
          : p.continuation
            ? t("ui.thisPageIsEmptyTheNextPage")
            : t("ui.noMatchingResults"),
    );
    if (filter) {
      const clear = document.createElement("button");
      setText(clear, () => t("ui.clearFilter"));
      clear.onclick = () => {
        $("result-filter").value = "";
        renderPage();
        $("result-filter").focus();
      };
      el.append(clear);
    }
    target.append(el);
    return;
  }
  const columns = tableColumns(allColumns),
    table = document.createElement("table"),
    thead = table.createTHead(),
    tr = thead.insertRow();
  table.className = "result-table";
  const colgroup = document.createElement("colgroup");
  table.prepend(colgroup);
  for (const [columnIndex, name] of ["#", "", ...columns].entries()) {
    const col = document.createElement("col");
    const width = columnIndex < 2 ? 48 : state.tablePrefs.widths[name] || 180;
    col.style.width = `${width}px`;
    colgroup.append(col);
    const th = document.createElement("th");
    if (columnIndex === 1) setText(th, () => t("results.actions"));
    else th.textContent = name;
    th.style.width = `${width}px`;
    if (name === "id") th.classList.add("pinned-id");
    if (columnIndex >= 2) {
      const handle = document.createElement("span");
      handle.className = "column-resize";
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      setAttr(handle, "aria-label", () => t("ui.resizeColumn", () => [name]));
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-valuemin", "80");
      handle.setAttribute("aria-valuemax", "800");
      handle.setAttribute("aria-valuenow", String(width));
      const resize = (size) => {
        size = Math.max(80, Math.min(800, size));
        state.tablePrefs.widths[name] = size;
        col.style.width = th.style.width = `${size}px`;
        handle.setAttribute("aria-valuenow", String(size));
      };
      handle.onpointerdown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const x = e.clientX,
          initial = state.tablePrefs.widths[name] || 180;
        handle.setPointerCapture(e.pointerId);
        handle.onpointermove = (event) => resize(initial + event.clientX - x);
        handle.onpointerup = handle.onpointercancel = () => {
          handle.onpointermove = null;
          saveTablePreferences();
        };
      };
      handle.onkeydown = (e) => {
        if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
          e.preventDefault();
          resize(
            (state.tablePrefs.widths[name] || 180) +
              (e.key === "ArrowRight" ? 20 : -20),
          );
          saveTablePreferences();
        }
      };
      th.append(handle);
    }
    tr.append(th);
  }
  const tbody = table.createTBody();
  let selected;
  function selectCell(td, row, column) {
    if (selected) {
      selected.classList.remove("cell-selected");
      selected.tabIndex = -1;
    }
    for (const cell of tbody.querySelectorAll('td[tabindex="0"]'))
      cell.tabIndex = -1;
    selected = td;
    td.tabIndex = 0;
    td.classList.add("cell-selected");
    state.selectedCell = td.textContent;
    state.selectedRow = encodeJSON(row, null, 2);
    setAttr($("copy-cell"), "title", () => t("ui.copyCtrlC", () => [column]));
    for (const tr of tbody.rows)
      tr.classList.toggle("selected", tr === td.parentElement);
    controls();
  }
  rows.forEach(({ row, index }) => {
    const tr = tbody.insertRow();

    const number = tr.insertCell();
    number.textContent = String(index + 1);
    const actions = tr.insertCell(),
      read = document.createElement("button");
    const identity = rowIdentity(row, partitionPaths());
    read.innerHTML = identity
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    read.type = "button";
    read.className = "row-read icon-button";
    setAttr(read, "aria-label", () =>
      identity
        ? t("ui.readFullDocumentFromRow", () => [index + 1])
        : t("ui.previewQueryProjectionFromRow", () => [index + 1]),
    );
    read.disabled = state.busy;
    read.dataset.available = "true";
    setAttr(read, "title", () =>
      identity
        ? t("ui.readUsingThisRowSIdAnd")
        : t("ui.previewOnlyIncludeIdAndPartitionFields", () => [
            partitionPaths().join(", "),
          ]),
    );
    read.onclick = (e) => {
      e.stopPropagation();
      if (!identity) {
        void select();
        return;
      }
      void action(async () => {
        if (await discard())
          opened(await invoke("cosmos/read", { ...scope(), ...identity }), {
            ...scope(),
            ...identity,
          });
      });
    };
    actions.append(read);
    for (const k of columns) {
      const value = k === "(value)" ? row : row?.[k];
      const td = tr.insertCell();
      td.textContent = cellText(value);
      setAttr(td, "title", () => td.textContent);
      if (k === "id") td.classList.add("pinned-id");
      td.tabIndex = index === rows[0]?.index && k === columns[0] ? 0 : -1;
      td.addEventListener("focus", () => selectCell(td, row, k));
      td.addEventListener("click", () => {
        selectCell(td, row, k);
        td.focus({ preventScroll: true });
      });
      const openCopy = (x, y) => {
        selectCell(td, row, k);
        copyMenu.open({ x, y, focus: td });
      };
      td.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openCopy(event.clientX, event.clientY);
      });
      td.addEventListener("keydown", (e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const rect = td.getBoundingClientRect();
          openCopy(rect.left, rect.bottom);
          return;
        }
        if (
          (e.metaKey || e.ctrlKey) &&
          e.key.toLowerCase() === "c" &&
          !e.altKey
        ) {
          e.preventDefault();
          selectCell(td, row, k);
          void copyResult(state.selectedCell, msg("ui.cell"));
        } else if (
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
        ) {
          e.preventDefault();
          const r = tr.sectionRowIndex,
            c = td.cellIndex;
          const target =
            e.key === "ArrowLeft"
              ? tr.cells[Math.max(2, c - 1)]
              : e.key === "ArrowRight"
                ? tr.cells[Math.min(tr.cells.length - 1, c + 1)]
                : tbody.rows[r + (e.key === "ArrowUp" ? -1 : 1)]?.cells[c];
          target?.click();
          target?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      });
    }
    const select = () =>
      action(async () => {
        if (!(await discard())) return;
        resetEditor();
        showDocument();
        state.selectedRow = encodeJSON(row, null, 2);
        documentState.baseline = encodeJSON(row, null, 2);
        documentEditor.value = documentState.baseline;
        setText($("document-state"), () => t("ui.queryProjectionReadOnly"));
        if (row && typeof row.id === "string") $("document-id").value = row.id;
        const paths =
          scopeState.containers.find((x) => x.id === scopeState.container)
            ?.partitionKey?.paths || [];
        // A projected row may omit partition fields. Require an explicit key then.
        const missing = paths.some((path) => {
          let value = row;
          for (const part of path
            .slice(1)
            .split("/")
            .map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"))) {
            if (
              !value ||
              typeof value !== "object" ||
              !Object.hasOwn(value, part)
            )
              return true;
            value = value[part];
          }
          return false;
        });
        try {
          if (!missing) $("document-pk").value = keyFromDocument(row, paths);
        } catch (error) {
          status(error, true);
          return;
        }
        target
          .querySelectorAll("tr.selected")
          .forEach((x) => x.classList.remove("selected"));
        tr.classList.add("selected");
        let previewView = state.preferredDocumentView;
        try {
          editableDocument(row);
        } catch {
          previewView = "json";
        }
        setDocumentView(previewView);
        controls();
        status(msg("ui.queryProjectionPreviewedConfirmTheIdAnd"));
      });
    tr.addEventListener("dblclick", (e) => {
      if (!e.target.closest("button")) void select();
    });
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.target.closest("button")) {
        e.preventDefault();
        void select();
      }
    });
  });
  target.append(table);
  target.scrollLeft = scrollLeft;
  target.scrollTop = scrollTop;
}

let scopePicker = null;
function closeScopePicker(focus = false) {
  const trigger = scopePicker?.trigger;
  scopePicker = null;
  $("scope-picker").hidden = true;
  for (const id of ["scope-database", "scope-container"])
    $(id).setAttribute("aria-expanded", "false");
  if (focus && trigger && !$(trigger).disabled) $(trigger).focus();
}
function liveScopePicker(context) {
  return (
    scopePicker === context &&
    context.epoch === state.epoch &&
    context.connection === state.connectionId &&
    context.database === scopeState.database
  );
}
async function openScopePicker(kind, refresh = false) {
  if (
    state.busy ||
    !state.connectionId ||
    (kind === "container" && !scopeState.database)
  )
    return;
  closeScopeInfo();
  closeScopePicker();
  const context = (scopePicker = {
    kind,
    trigger: `scope-${kind}`,
    database: scopeState.database,
    connection: state.connectionId,
    epoch: state.epoch,
    items: [],
    loading: true,
    error: "",
  });
  const picker = $("scope-picker");
  setText($("scope-picker-title"), () =>
    kind === "database"
      ? t("scope.selectDatabase")
      : t("ui.selectContainer", () => [scopeState.database]),
  );
  $("scope-filter").value = "";
  picker.hidden = false;
  $(context.trigger).setAttribute("aria-expanded", "true");
  const rect = $(context.trigger).getBoundingClientRect();
  picker.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(400, window.innerWidth - 24) - 12))}px`;
  picker.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 260))}px`;
  renderScopeOptions();
  $("scope-filter").focus();
  try {
    let items =
      kind === "database"
        ? scopeState.databaseChoices
        : scopeState.containerChoices.get(context.database);
    if (refresh || !items) {
      items = await listAll(
        kind === "database" ? "cosmos/databases" : "cosmos/containers",
        { database: context.database, browse: true },
      );
      if (!liveScopePicker(context)) return;
      if (kind === "database") scopeState.databaseChoices = items;
      else scopeState.containerChoices.set(context.database, items);
    }
    if (!liveScopePicker(context)) return;
    context.items = items;
  } catch (error) {
    if (!liveScopePicker(context)) return;
    context.error = error || msg("ui.couldNotLoadTheListPleaseRetry");
  }
  if (liveScopePicker(context)) {
    context.loading = false;
    renderScopeOptions();
  }
}
function renderScopeOptions() {
  const context = scopePicker;
  if (!context) return;
  const needle = $("scope-filter").value.trim().toLowerCase();
  const items = context.items.filter((item) =>
    item.id.toLowerCase().includes(needle),
  );
  const target = $("scope-options");
  target.replaceChildren();
  $("scope-reload").disabled = context.loading;
  setText($("scope-picker-status"), () =>
    context.loading
      ? t("ui.loadingList")
      : renderMessage(context.error) ||
        t("ui.items", () => [items.length, context.items.length]),
  );
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "scope-empty";
    setText(empty, () =>
      context.loading
        ? t("ui.pleaseWait")
        : context.error
          ? t("ui.couldNotLoadTheListRefreshTo")
          : needle
            ? t("ui.noMatchingNames")
            : t("ui.noAvailableItems"),
    );
    target.append(empty);
  }
  const selected =
    context.kind === "database" ? scopeState.database : scopeState.container;
  for (const item of items) {
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(item.id === selected));
    option.textContent = item.id;
    setAttr(option, "title", () => item.id);
    option.onclick = () => chooseScope(context, item.id);
    target.append(option);
  }
}
async function chooseScope(context, id) {
  if (!liveScopePicker(context) || state.busy) return;
  const same =
    id ===
    (context.kind === "database" ? scopeState.database : scopeState.container);
  closeScopePicker(true);
  if (same) return;
  let switched = false;
  await action(async () => {
    if (!(await discard()) || context.epoch !== state.epoch) return;
    await pauseDiscovery();
    if (context.kind === "database") {
      options("database", context.items, msg("scope.selectDatabase"));
      $("database").value = id;
      await selectDatabase(id, { browse: true });
    } else {
      scopeState.containers = context.items;
      options("container", context.items, msg("scope.selectContainer"));
      await selectContainer(id);
    }
    switched = true;
  });
  if (
    switched &&
    context.kind === "database" &&
    context.epoch === state.epoch &&
    !state.busy
  )
    void openScopePicker("container");
}
$("scope-database").onclick = () => void openScopePicker("database");
$("scope-container").onclick = () => void openScopePicker("container");
$("scope-filter").oninput = renderScopeOptions;
$("scope-reload").onclick = () =>
  scopePicker && void openScopePicker(scopePicker.kind, true);
$("scope-close").onclick = () => closeScopePicker(true);
$("scope-picker").onkeydown = (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeScopePicker(true);
    return;
  }
  const options = [...$("scope-options").querySelectorAll("button")];
  if (event.target === $("scope-filter") && event.key === "Enter") {
    event.preventDefault();
    options[0]?.click();
    return;
  }
  if (
    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
    (event.target === $("scope-filter") && !event.key.startsWith("Arrow"))
  )
    return;
  event.preventDefault();
  const current = options.indexOf(document.activeElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : current < 0
          ? event.key === "ArrowUp"
            ? options.length - 1
            : 0
          : (current + (event.key === "ArrowUp" ? -1 : 1) + options.length) %
            options.length;
  options[next]?.focus();
};
document.addEventListener("pointerdown", (event) => {
  if (
    !$("scope-picker").contains(event.target) &&
    !event.target.closest(".scope-select")
  )
    closeScopePicker();
});
document.addEventListener("focusin", (event) => {
  if (
    !$("scope-picker").contains(event.target) &&
    !event.target.closest(".scope-select")
  )
    closeScopePicker();
});
window.addEventListener("resize", () => closeScopePicker());

function updateScopeContext() {
  const scoped = !!(scopeState.savedDatabase && scopeState.savedContainer);
  document.body.classList.toggle("container-scoped", scoped);
  $("scope-context").hidden = !scoped;
  setText($("scope-panel-title"), () =>
    scoped ? t("scope.containerInfo") : t("scope.title"),
  );
  setAttr($("scope-panel"), "aria-label", () =>
    scoped ? t("scope.containerInfo") : t("scope.title"),
  );
  setAttr($("refresh"), "title", () =>
    scoped ? t("ui.refreshContainerMetadata") : t("ui.refreshDatabaseList"),
  );
  setAttr($("refresh"), "aria-label", () => $("refresh").title);
  for (const [id, value] of [
    ["scope-connection", state.connectionName],
    [
      "scope-database",
      scopeState.database ||
        scopeState.savedDatabase ||
        msg("scope.selectDatabase"),
    ],
    [
      "scope-container",
      scopeState.container ||
        (scopeState.database
          ? msg("scope.selectContainer")
          : scopeState.savedContainer) ||
        msg("scope.selectContainer"),
    ],
  ]) {
    setText($(id), () => value);
    setAttr($(id), "title", () => value);
  }
  $("scope-connection").hidden = !state.connectionName;
  $("scope-connection-divider").hidden = !state.connectionName;
  closeScopeInfo();
  closeScopePicker();
}
function closeScopeInfo(focus = false) {
  document.body.classList.remove("scope-info-open");
  $("scope-info").setAttribute("aria-expanded", "false");
  if (focus) $("scope-info").focus();
}
$("scope-info").onclick = () => {
  closeScopePicker();
  const open = !document.body.classList.contains("scope-info-open");
  document.body.classList.toggle("scope-info-open", open);
  $("scope-info").setAttribute("aria-expanded", String(open));
  if (open) {
    $("scope-metadata").open = true;
    const rect = $("scope-info").getBoundingClientRect();
    $("scope-panel").style.left =
      `${Math.max(12, Math.min(rect.right - 400, window.innerWidth - Math.min(400, window.innerWidth - 24) - 12))}px`;
    $("refresh").focus();
  }
};
document.addEventListener("pointerdown", (event) => {
  if (
    !$("scope-panel").contains(event.target) &&
    !$("scope-info").contains(event.target)
  )
    closeScopeInfo();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    document.body.classList.contains("scope-info-open")
  ) {
    event.preventDefault();
    closeScopeInfo(true);
  }
});
document.addEventListener("focusin", (event) => {
  if (
    !$("scope-panel").contains(event.target) &&
    !$("scope-info").contains(event.target)
  )
    closeScopeInfo();
});
window.addEventListener("resize", () => closeScopeInfo());
let changeDocument,
  changeBaseline,
  fieldChanges = [];
function updateFieldChanges() {
  const text =
    documentState.snapshot || documentState.creating
      ? documentEditor.value
      : "{}";
  const baseline = documentState.baseline || "{}";
  if (text !== changeDocument || baseline !== changeBaseline) {
    changeDocument = text;
    changeBaseline = baseline;
    fieldChanges = [];
    try {
      fieldChanges = documentChanges(parseJSON(baseline), parseJSON(text));
    } catch {
      /* Invalid drafts remain editable; never infer a change count. */
    }
  }
  const changes = fieldChanges;
  const summary = $("draft-summary");
  summary.hidden =
    !(documentState.snapshot || documentState.creating) ||
    (!changes.length && !documentState.fieldErrors.size && !documentError);
  setText(summary, () =>
    documentState.fieldErrors.size || documentError
      ? t("ui.invalidDraftFixTheFormatFirst")
      : t("document.changedFieldCount", () => [changes.length]),
  );
  for (const card of $("field-list").querySelectorAll(".field-card")) {
    const changed = changes.some(
      (change) =>
        change.path === card.dataset.path ||
        change.path.startsWith(card.dataset.path + "/") ||
        card.dataset.path.startsWith(change.path + "/"),
    );
    card.classList.toggle("field-modified", changed);
    card.querySelector(".field-change").hidden = !changed;
  }
}
function draftChanged() {
  setText($("document-state"), () =>
    dirty()
      ? t("document.unsaved")
      : documentState.creating
        ? t("document.new")
        : t("document.full"),
  );
  controls();
}
function setDocumentView(view, remember = false) {
  if (documentState.fieldErrors.size && view !== state.documentView) {
    status(msg("ui.fixInvalidFieldValuesBeforeSwitchingViews"), true);
    return;
  }
  if (view === "fields") {
    try {
      renderFields();
    } catch (error) {
      status(
        msg("ui.invalidJsonDocumentFixItInThe", () => [renderMessage(error)]),
        true,
      );
      return;
    }
  }
  state.documentView = view;
  if (remember) {
    state.preferredDocumentView = view;
    saveViewPreference({ document: view });
  }
  $("field-editor").hidden = view !== "fields";
  $("editor").hidden = view !== "json";
  $("json-diagnostic").hidden = !documentError || view !== "json";
  $("document-more").hidden = view !== "json";
  closeDocumentMenu();
  documentEditor.measure();
  $("fields-view").classList.toggle("active", view === "fields");
  $("fields-view").setAttribute("aria-pressed", String(view === "fields"));
  $("document-json-view").setAttribute("aria-pressed", String(view === "json"));
  $("document-json-view").classList.toggle("active", view === "json");
  controls();
}
function renderFields() {
  const doc = parseJSON(documentEditor.value),
    rows = documentFields(doc, partitionPaths()),
    target = $("field-list"),
    needle = $("field-filter").value.trim().toLowerCase();
  target.replaceChildren();
  for (const row of rows.filter((x) => x.path.toLowerCase().includes(needle))) {
    const card = document.createElement("div");
    card.className = "field-card";
    card.dataset.path = row.path;
    const label = document.createElement("label"),
      title = document.createElement("span");
    title.className = "field-title";
    title.textContent = row.path;
    setAttr(title, "title", () => row.path);
    const kind = document.createElement("span");
    kind.className = "field-kind";
    setText(kind, () =>
      row.locked
        ? t("common.readOnly")
        : {
            string: t("ui.text"),
            number: t("ui.number"),
            boolean: t("ui.boolean"),
            json: "JSON",
          }[row.kind],
    );
    const marker = document.createElement("span");
    marker.className = "field-change";
    setText(marker, () => t("ui.modified"));
    marker.hidden = true;
    const caption = document.createElement("span");
    caption.className = "field-caption";
    caption.append(title, kind, marker);
    const input =
      row.kind === "boolean"
        ? document.createElement("select")
        : document.createElement(
            (row.kind === "json" && row.value !== null) ||
              (row.kind === "string" &&
                (String(row.value).length > 80 || /[\r\n]/.test(row.value)))
              ? "textarea"
              : "input",
          );
    if (row.kind === "boolean")
      for (const value of ["true", "false"])
        input.add(new Option(value, value));
    if (input.tagName === "TEXTAREA") {
      input.rows = 3;
      card.classList.add("field-multiline");
    }
    input.value = row.kind === "string" ? row.value : encodeJSON(row.value);
    setAttr(input, "aria-label", () => t("ui.field", () => [row.path]));
    input.dataset.locked = String(row.locked);
    const error = document.createElement("small");
    error.className = "field-error";
    error.setAttribute("role", "status");
    input.oninput = () => {
      if (state.busy || state.readOnly || row.locked) return;
      try {
        const value = parseFieldInput(input.value, row.kind),
          next = editDocumentField(
            parseJSON(documentEditor.value),
            row.path,
            value,
            partitionPaths(),
          );
        documentEditor.value = encodeJSON(next, null, 2);
        documentState.fieldErrors.delete(row.path);
        setText(error, () => "");
        input.removeAttribute("aria-invalid");
        draftChanged();
      } catch (e) {
        documentState.fieldErrors.set(row.path, e.message);
        setText(error, () => renderMessage(e.message));
        input.setAttribute("aria-invalid", "true");
        controls();
      }
    };
    const remove = document.createElement("button");
    remove.type = "button";
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg>';
    setAttr(remove, "title", () => t("ui.deleteField", () => [row.path]));
    remove.className = "remove-field icon-button";
    remove.dataset.locked = String(row.locked);
    setAttr(remove, "aria-label", () => t("ui.deleteField", () => [row.path]));
    remove.onclick = () => {
      if (state.busy || state.readOnly || row.locked) return;
      if (
        [...documentState.fieldErrors.keys()].some((path) => path !== row.path)
      ) {
        status(msg("ui.fixOtherInvalidFieldValuesBeforeDeleting"), true);
        return;
      }
      try {
        documentEditor.value = encodeJSON(
          editDocumentField(
            parseJSON(documentEditor.value),
            row.path,
            null,
            partitionPaths(),
            true,
          ),
          null,
          2,
        );
        documentState.fieldErrors.delete(row.path);
        renderFields();
        draftChanged();
      } catch (error) {
        status(error, true);
      }
    };
    label.append(caption, input);
    card.append(label, remove, error);
    target.append(card);
  }
  updateFieldChanges();
  if (!target.children.length) {
    const empty = document.createElement("p");
    empty.className = "info";
    setText(empty, () => t("ui.noMatchingFields"));
    target.append(empty);
  }
}
$("document-search").onclick = () => {
  if (documentState.fieldErrors.size) {
    status(msg("ui.fixInvalidFieldValuesBeforeSearchingJson"), true);
    return;
  }
  setDocumentView("json", true);
  documentEditor.search();
};
function closeDocumentMenu(focus = false) {
  $("document-menu").hidden = true;
  $("document-more").setAttribute("aria-expanded", "false");
  if (focus) $("document-more").focus();
}
function documentActions() {
  const invalid = !!documentError || !documentEditor.value.trim();
  $("document-fold").disabled =
    state.busy || invalid || !documentEditor.nestedFoldCount;
  setAttr($("document-fold"), "title", () =>
    invalid
      ? t("ui.fixJsonFirst")
      : documentEditor.nestedFoldCount
        ? t("ui.foldNestedObjectsAndArraysKeepingTop")
        : t("ui.thisDocumentHasNoFoldableNestedObjects"),
  );
  $("document-unfold").disabled = state.busy || !documentEditor.foldedCount;
}
function openDocumentMenu(last = false) {
  if ($("document-more").disabled) return;
  documentActions();
  $("document-menu").hidden = false;
  $("document-more").setAttribute("aria-expanded", "true");
  const items = [
    ...$("document-menu").querySelectorAll("button:not(:disabled)"),
  ];
  (last ? items.at(-1) : items[0])?.focus();
}
$("document-more").onclick = () =>
  $("document-menu").hidden ? openDocumentMenu() : closeDocumentMenu(true);
$("document-more").onkeydown = (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    openDocumentMenu(event.key === "ArrowUp");
  }
};
$("document-menu").onkeydown = (event) => {
  const items = [
    ...$("document-menu").querySelectorAll("button:not(:disabled)"),
  ];
  const index = items.indexOf(document.activeElement);
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    items[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length
    ]?.focus();
  }
};
for (const [id, method] of [
  ["document-format", "format"],
  ["document-fold", "fold"],
  ["document-unfold", "unfold"],
]) {
  $(id).onclick = () => {
    closeDocumentMenu(true);
    documentEditor[method]();
  };
}
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".menu-anchor")) closeDocumentMenu();
});
document.addEventListener("focusin", (event) => {
  if (!event.target.closest(".menu-anchor")) closeDocumentMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("document-menu").hidden) {
    event.preventDefault();
    closeDocumentMenu(true);
  }
});
$("document-location").addEventListener("toggle", () =>
  documentEditor.measure(),
);
$("json-diagnostic").onclick = () => documentEditor.focusError();
const workspace = document.querySelector(".workspace"),
  separator = $("document-resize");
function resizeDocument(width) {
  const max = Math.max(290, Math.min(900, workspace.clientWidth - 540));
  width = Math.round(Math.max(290, Math.min(max, width)));
  workspace.style.setProperty("--document-width", `${width}px`);
  separator.setAttribute("aria-valuemax", String(max));
  separator.setAttribute("aria-valuenow", String(width));
  documentEditor.measure();
  sqlEditor.measure();
}
separator.onpointerdown = (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  separator.setPointerCapture(e.pointerId);
};
separator.onpointermove = (e) => {
  if (separator.hasPointerCapture(e.pointerId))
    resizeDocument(workspace.getBoundingClientRect().right - e.clientX);
};
separator.onpointerup = (e) => {
  if (separator.hasPointerCapture(e.pointerId))
    separator.releasePointerCapture(e.pointerId);
};
separator.onkeydown = (e) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const width = Number(separator.getAttribute("aria-valuenow"));
  resizeDocument(
    e.key === "Home"
      ? 290
      : e.key === "End"
        ? 900
        : width + (e.key === "ArrowLeft" ? 30 : -30),
  );
};
$("document-expand").onclick = () => {
  const expanded = workspace.classList.toggle("document-expanded");
  $("document-expand").innerHTML = icon(expanded ? "restore" : "expand");
  setAttr($("document-expand"), "aria-label", () =>
    expanded ? t("ui.restoreDocumentPanel") : t("ui.expandDocumentPanel"),
  );
  setAttr($("document-expand"), "title", () =>
    expanded ? t("ui.restoreDocumentPanel") : t("ui.expandDocumentPanel"),
  );
  $("document-expand").setAttribute("aria-pressed", String(expanded));
  documentEditor.measure();
  sqlEditor.measure();
};
window.addEventListener("resize", () =>
  resizeDocument(Number(separator.getAttribute("aria-valuenow"))),
);
$("fields-view").onclick = () => {
  setDocumentView("fields", true);
};
$("document-json-view").onclick = () => {
  setDocumentView("json", true);
};
$("field-filter").oninput = () => {
  if (documentState.fieldErrors.size) {
    status(msg("ui.fixInvalidFieldValuesBeforeFiltering"), true);
    return;
  }
  try {
    renderFields();
    controls();
  } catch (error) {
    status(error, true);
  }
};
$("add-field").onclick = () => {
  if (
    state.busy ||
    state.readOnly ||
    (!documentState.snapshot && !documentState.creating)
  )
    return;
  try {
    if (documentState.fieldErrors.size)
      throw new LocalizedError(msg("ui.fixInvalidFieldValuesFirst"));
    const path = $("add-field-path").value.trim(),
      doc = parseJSON(documentEditor.value);
    if (documentPathExists(doc, path))
      throw new LocalizedError(
        msg("ui.fieldAlreadyExistsEditTheExistingField"),
      );
    documentEditor.value = encodeJSON(
      editDocumentField(
        doc,
        path,
        parseJSON($("add-field-value").value),
        partitionPaths(),
      ),
      null,
      2,
    );
    $("add-field-path").value = "";
    renderFields();
    draftChanged();
  } catch (error) {
    status(error, true);
  }
};

function syncDraftPartition() {
  if (!documentState.creating) return;
  try {
    const doc = applyDocumentPartition(
      editableDocument(parseJSON(documentEditor.value)),
      $("document-pk").value,
      partitionPaths(),
    );
    documentEditor.value = encodeJSON(doc, null, 2);
    $("document-id").value = doc.id || "";
    if (state.documentView === "fields") renderFields();
    controls();
  } catch (error) {
    status(error, true);
  }
}
async function pauseDiscovery() {
  const loader = candidates().loader;
  loader?.stop();
  if (loader?.task) await loader.task;
}
async function afterMutation(result, identity, verb) {
  const notes = [];
  try {
    const saved = await invoke("cosmos/partitionCache", scope());
    if (saved.found) {
      const old = candidates(),
        next = new PartitionCandidates();
      old.loader?.stop();
      next.selected = old.selected;
      for (const key of saved.keys) next.add(key);
      next.hydrated = true;
      next.cachedAt = saved.updatedAt;
      next.stats.seek.started = saved.complete || !!saved.continuation;
      next.stats.seek.continuation = saved.continuation || "";
      partitionScopes.set(partitionScope(), next);
    }
  } catch (error) {
    if (error.message === "STALE") throw error;
    notes.push(msg("ui.couldNotReadThePartitionKeyCache"));
  }
  const previousPage = queryState.pages[queryState.page];
  const previous = previousPage?.spec;
  if (previous) {
    const spec = { ...previous };
    delete spec.continuation;
    try {
      const refreshed = await invoke("cosmos/query", spec);
      queryState.resultStale = false;
      queryState.pages = [
        { ...refreshed, spec, execution: previousPage.execution },
      ];
      queryState.page = 0;
      renderPage();
      notes.push(
        msg("ui.previousQueryRefreshedToPageRu", () => [
          refreshed.ru.toFixed(2),
        ]),
      );
    } catch (error) {
      if (error.message === "STALE") throw error;
      queryState.pages = [];
      queryState.page = -1;
      renderPage();
      notes.push(
        msg("ui.couldNotRefreshTheQueryRunIt", () => [renderMessage(error)]),
      );
    }
  }
  if (result.cacheWarning) notes.push(result.cacheWarning);
  status(
    msg("ui.succeededRu", () => [
      renderMessage(verb),
      result.ru.toFixed(2),
      notes.length ? " · " + notes.map(renderMessage).join("；") : "",
    ]),
  );
}
function view(json, remember = true) {
  state.resultView = json ? "json" : "table";
  if (remember) saveViewPreference({ results: state.resultView });
  closeResultItemMenu();
  $("table").hidden = json && queryState.page >= 0;
  $("raw-results").hidden = !json || queryState.page < 0;
  $("table-view").classList.toggle("active", !json);
  $("table-view").setAttribute("aria-pressed", String(!json));
  $("json-view").setAttribute("aria-pressed", String(json));
  $("json-view").classList.toggle("active", json);
  $("table-tools").hidden = json;
  $("result-json-tools").hidden = !json;
  if (json) syncResultReader();
}
for (const [id, name, label] of [
  ["export", "download", msg("ui.exportCurrentPage")],
  ["copy-selection", "copy", msg("ui.copySelectedContent")],
  ["copy-results-json", "copy", msg("ui.copyCurrentPageJson")],
  ["document-expand", "expand", msg("ui.expandDocumentPanel")],
  ["document-close", "close", msg("ui.closeDocumentPanelKeepDraft")],
  ["clear-filter", "close", msg("ui.clearResultFilter")],
  ["scope-reload", "refresh", msg("ui.refreshList")],
  ["pk-reload", "refresh", msg("ui.refreshPartitionKeys")],
  ["pk-clear", "close", msg("ui.clearPartitionKey")],
  ["document-actions", "more", msg("ui.moreDocumentActions")],
  ["query-pk-choose", "down", msg("partition.chooseQueryKey")],
  ["document-pk-choose", "down", msg("partition.chooseDocumentKey")],
]) {
  $(id).innerHTML = icon(name);
  $(id).classList.add("icon-button");
  setAttr($(id), "title", () => renderMessage(label));
  setAttr($(id), "aria-label", () => renderMessage(label));
}
copyMenu = createMenu($("copy-selection"), $("copy-menu"));
documentWriteMenu = createMenu(
  $("document-actions"),
  $("document-actions-menu"),
);
const bind = (id, fn) => $(id).addEventListener("click", () => action(fn));
bind("refresh", async () => {
  if (await discard()) await loadDatabases();
});
$("database").addEventListener("change", () =>
  action(async () => {
    const next = $("database").value;
    if (!(await discard())) {
      $("database").value = scopeState.database;
      return;
    }
    await selectDatabase(next);
  }),
);
$("container").addEventListener("change", () =>
  action(async () => {
    const next = $("container").value;
    if (!(await discard())) {
      $("container").value = scopeState.container;
      return;
    }
    await selectContainer(next);
  }),
);
bind("run", () => query());
$("cancel-query").onclick = cancelQuery;
$("result-filter").oninput = renderPage;
$("clear-filter").onclick = () => {
  $("result-filter").value = "";
  renderPage();
  $("result-filter").focus();
};
$("copy-cell").onclick = () => {
  copyMenu.close(true);
  if (state.selectedCell !== null)
    void copyResult(state.selectedCell, msg("ui.cell"));
};
$("copy-row").onclick = () => {
  copyMenu.close(true);
  if (state.selectedRow !== null)
    void copyResult(state.selectedRow, msg("ui.rowJsonQueryProjection"));
};
$("pk-load").onclick = () => {
  if (state.busy) return;
  const loader = candidates().loader;
  if (loader?.running) loader.stop();
  else void startPartitionOptions();
};
$("pk-reload").onclick = () => {
  if (!state.busy) void startPartitionOptions(true);
};
for (const id of ["query-pk", "document-pk"]) {
  $(id + "-choose").onclick = () => {
    if (!$("pk-picker").hidden && partitionTarget === id) {
      closePartitionPicker();
      $(id).focus();
    } else openPartitionPicker(id);
  };
  $(id).addEventListener("focus", () => {
    if (partitionTarget !== id && !$("pk-picker").hidden)
      closePartitionPicker();
  });
  $(id).addEventListener("input", () => {
    try {
      parseArray($(id).value, msg("partition.key"));
      if (partitionTarget === id) closePartitionPicker();
      return;
    } catch {
      /* A keyword or incomplete JSON can filter local suggestions. */
    }
    if ($("pk-picker").hidden || partitionTarget !== id)
      openPartitionPicker(id, false);
    else {
      partitionFilter = $(id).value;
      partitionActiveKey = null;
      renderPartitionOptions();
    }
  });
  $(id).addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      if ($("pk-picker").hidden) openPartitionPicker(id);
      else if (!partitionBrowseRequested) {
        partitionBrowseRequested = true;
        void startPartitionOptions();
      }
      const items = [
        ...$("pk-options").querySelectorAll("button:not(:disabled)"),
      ];
      const current = items.findIndex(
        (item) => item.dataset.key === partitionActiveKey,
      );
      const next =
        current < 0
          ? event.key === "ArrowDown"
            ? 0
            : items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
      partitionActiveKey = items[next]?.dataset.key || null;
      renderPartitionOptions();
      const active = document.getElementById(
        $(id).getAttribute("aria-activedescendant"),
      );
      active?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && !$("pk-picker").hidden) {
      event.preventDefault();
      const active = document.getElementById(
        $(id).getAttribute("aria-activedescendant"),
      );
      if (active) active.click();
      else {
        closePartitionPicker();
        $(id).dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else if (event.key === "Tab") closePartitionPicker();
  });
}
$("pk-clear").onclick = () => {
  if (!state.busy) {
    $(partitionTarget).value = "";
    renderResultSummary();
    if (partitionTarget === "query-pk") candidates().selected = "";
    closePartitionPicker();
    $(partitionTarget).focus();
  }
};
document.addEventListener("pointerdown", (e) => {
  if (
    !$("pk-picker").hidden &&
    !$("pk-picker").contains(e.target) &&
    !e.target.closest(".pk-input")
  )
    closePartitionPicker();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("pk-picker").hidden) {
    e.preventDefault();
    closePartitionPicker();
    $(partitionTarget).focus();
  }
});
window.addEventListener("resize", closePartitionPicker);
$("query-pk").addEventListener("change", () => {
  if (scopeState.container) {
    rememberKey($("query-pk").value);
    candidates().selected = $("query-pk").value;
  }
});
bind("next", () => query(true));
bind("previous", async () => {
  if (await discard()) {
    queryState.page--;
    renderPage();
    resetEditor();
    clearStatus();
  }
});
bind("read", async () => {
  if (await discard()) {
    const identity = point();
    opened(await invoke("cosmos/read", identity), identity);
  }
});
bind("new", async () => {
  if (!(await discard())) return;
  const key = $("query-pk").value.trim() || $("document-pk").value.trim();
  const doc = newDocument(partitionPaths(), key, crypto.randomUUID());
  resetEditor();
  showDocument();
  documentState.creating = true;
  documentState.baseline = encodeJSON(doc, null, 2);
  documentEditor.value = documentState.baseline;
  $("document-id").value = doc.id;
  $("document-pk").value = key;
  setText($("document-state"), () => t("document.new"));
  setText($("etag"), () => t("ui.newDocumentsUseCreateAnExistingId"));
  setDocumentView(state.preferredDocumentView);
  status(msg("ui.editingANewDocument"));
});

bind("save", () => saveDocument());
bind("replace-document", () => saveDocument(true));
$("replace-document").addEventListener("click", () =>
  documentWriteMenu.close(),
);
bind("delete", () => deleteDocument());
bind("export", async () => {
  const p = queryState.pages[queryState.page];
  const { rows, filter } = pageRows();
  const bytes = new TextEncoder().encode(
    filter
      ? encodeJSON(
          rows.map((x) => x.row),
          null,
          2,
        )
      : p.json,
  );
  if (bytes.length > 1024 * 1024)
    throw new LocalizedError(msg("ui.thisPageExceedsMibReduceThePage"));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const result = await host.request("host.saveFile", {
    fileName: `${scopeState.container}-page-${queryState.page + 1}${filter ? "-filtered" : ""}.json`,
    contentType: "application/json",
    dataBase64: btoa(binary),
  });
  status(result ? msg("ui.currentPageExported") : msg("ui.exportCanceled"));
});
$("table-view").onclick = () => view(false);
$("json-view").onclick = () => view(true);
$("result-json-search").onclick = () => {
  if (resultEditor && !state.busy) resultEditor.search();
};
$("copy-results-json").onclick = () => {
  if (!resultEditor || state.busy || queryState.page < 0) return;
  void copyResult(
    resultEditor.value,
    $("result-filter").value.trim()
      ? msg("ui.filteredCurrentPageJson")
      : msg("ui.currentPageJson"),
  );
};
documentEditor.onChange(() => {
  setText($("document-state"), () =>
    dirty()
      ? t("document.unsaved")
      : documentState.creating
        ? t("document.new")
        : t("document.full"),
  );
  if (documentState.creating) {
    try {
      $("document-id").value = parseJSON(documentEditor.value).id || "";
    } catch {}
  }
  controls();
});
$("document-pk").addEventListener("input", () => {
  try {
    parseArray($("document-pk").value, msg("partition.key"));
  } catch {
    return;
  }
  syncDraftPartition();
});
$("document-id").addEventListener("input", () => {
  if (!documentState.creating) return;
  try {
    const doc = editableDocument(parseJSON(documentEditor.value));
    doc.id = $("document-id").value;
    documentEditor.value = encodeJSON(doc, null, 2);
    if (state.documentView === "fields") renderFields();
    controls();
  } catch (error) {
    status(error, true);
  }
});
bind("generate-id", async () => {
  documentWriteMenu.close();
  const doc = editableDocument(parseJSON(documentEditor.value));
  doc.id = crypto.randomUUID();
  const paths = partitionPaths();
  if (paths.includes("/id")) {
    const values = parseArray($("document-pk").value, msg("partition.key"));
    values[paths.indexOf("/id")] = doc.id;
    $("document-pk").value = encodeJSON(values);
  }
  documentEditor.value = encodeJSON(doc, null, 2);
  $("document-id").value = doc.id;
  if (state.documentView === "fields") renderFields();
  status(msg("ui.newDocumentUuidGenerated"));
});
// Capture before CodeMirror's Mod-Enter binding can insert a blank line and
// collapse the selection that the user intended to execute.
document.addEventListener(
  "keydown",
  (e) => {
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key === "Enter" &&
      !e.isComposing &&
      e.target.closest(".query-panel") &&
      !$("confirm-dialog").open
    ) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (!$("run").disabled) $("run").click();
    }
  },
  true,
);
async function contextChanged(context) {
  const id = context?.connectionId || context?.connection?.id || "";
  if (id === state.connectionId) return;
  if (queryState.queryJob) cancelQuery();
  for (const cache of partitionScopes.values()) cache.loader?.stop();
  partitionScopes.clear();
  fieldScopes.clear();
  if ($("confirm-dialog").open) $("confirm-dialog").close("cancel");
  state.epoch++;
  state.connectionId = id;
  scopeState.database = "";
  scopeState.container = "";
  activatePartitionScope();
  state.readOnly = true;
  scopeState.savedDatabase = "";
  scopeState.savedContainer = "";
  scopeState.databaseChoices = null;
  scopeState.containerChoices.clear();
  updateScopeContext();
  resetResults();
  options("database", [], msg("scope.selectDatabase"));
  options("container", [], msg("scope.selectContainer"));
  state.connectionName =
    context?.connection?.name || context?.connectionName || context?.name || "";
  setText(
    $("connection-name"),
    () =>
      state.connectionName ||
      (id
        ? t("ui.connectedToAzureCosmosDb")
        : t("ui.openASavedCosmosDbConnectionFrom")),
  );
  if (!id) {
    setText($("mode"), () => t("connection.disconnected"));
    status(msg("ui.openASavedCosmosDbConnectionFrom2"));
    controls();
    return;
  }
  // Context switches invalidate all earlier RPC responses before initializing the new view.
  state.busy = false;
  await action(async () => {
    const info = await invoke("cosmos/info");
    state.readOnly = info.readOnly;
    scopeState.savedDatabase = info.database || "";
    scopeState.savedContainer = info.container || "";
    updateScopeContext();
    setText($("mode"), () =>
      info.readOnly ? t("connection.readOnly") : t("connection.writesEnabled"),
    );
    await loadViewPreferences();
    await loadDatabases();
    if (info.scopeWarning) status(info.scopeWarning, true);
  });
}
controls();
if (host) {
  host.onContext(contextChanged);
  host.ready
    .then((context) => {
      syncLocale();
      const syncTheme = () =>
        document.body.classList.toggle(
          "light",
          host.theme?.appearance === "light",
        );
      syncTheme();
      new MutationObserver(syncTheme).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
      return contextChanged(context || host.context);
    })
    .catch((e) => status(e, true));
} else status(msg("ui.thisWorkbenchMustBeOpenedInThe"), true);

function clearSQLError() {
  sqlEditor.setDiagnostic(null);
  $("sql-diagnostic").hidden = true;
  $("sql-error").hidden = true;
}
function updateSQLExecution() {
  const selected = sqlEditor.execution.selected;
  const label = selected ? msg("query.runSelection") : msg("query.run");
  setText($("run"), () => renderMessage(label));
  setAttr($("run"), "title", () =>
    selected
      ? t("ui.runOnlyTheSelectedSqlCtrlEnter")
      : t("ui.runTheEntireSqlEditorCtrlEnter"),
  );
  renderResultSummary();
}
function updateParametersVisibility() {
  const panel = $("query-parameters");
  const text = $("parameters").value.trim();
  let populated = !!text;
  try {
    populated = text
      ? parseArray(text, msg("query.parameters")).length > 0
      : false;
  } catch {
    /* Keep invalid input accessible. */
  }
  const visible = populated || sqlParameterNames(sqlEditor.value).length > 0;
  if (panel.hidden && visible) panel.open = true;
  panel.hidden = !visible;
}
updateParametersVisibility();
$("parameters").addEventListener("input", updateParametersVisibility);
sqlEditor.onChange(() => {
  updateParametersVisibility();
  $("sql-diagnostic").hidden = true;
  $("sql-error").hidden = true;
});
sqlEditor.onSelection(updateSQLExecution);
updateSQLExecution();
$("sql-diagnostic").onclick = () => sqlEditor.focusError();
for (const id of ["query-pk", "parameters", "page-size"]) {
  $(id).addEventListener("input", renderResultSummary);
  $(id).addEventListener("change", renderResultSummary);
}
function showDocument() {
  workspace.classList.remove("document-hidden");
  $("document-toggle").hidden = true;
  setAttr($("document-toggle"), "title", () =>
    t("ui.closeDocumentPanelKeepDraft"),
  );
  $("document-toggle").setAttribute("aria-expanded", "true");
  documentEditor.measure();
  sqlEditor.measure();
}
function hideDocument(focus = false) {
  workspace.classList.add("document-hidden");
  workspace.classList.remove("document-expanded");
  $("document-expand").innerHTML = icon("expand");
  setAttr($("document-expand"), "aria-label", () =>
    t("ui.expandDocumentPanel"),
  );
  setAttr($("document-expand"), "title", () => t("ui.expandDocumentPanel"));
  $("document-expand").setAttribute("aria-pressed", "false");
  $("document-toggle").hidden = false;
  setAttr($("document-toggle"), "title", () =>
    t("ui.openDocumentPanelReadByIdOr"),
  );
  $("document-toggle").setAttribute("aria-expanded", "false");
  documentWriteMenu?.close();
  closeDocumentMenu();
  if (partitionTarget === "document-pk") closePartitionPicker();
  if (focus) $("document-toggle").focus();
  sqlEditor.measure();
}
$("document-toggle").onclick = () => {
  if (workspace.classList.contains("document-hidden")) {
    showDocument();
    if ($("document-location").open) $("document-id").focus();
    else if (state.documentView === "json") documentEditor.focus();
    else $("fields-view").focus();
  } else hideDocument(true);
};
$("document-close").onclick = () => hideDocument(true);
