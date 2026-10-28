import { validateSQLExecution, sqlErrorDiagnostic } from "./sql-execution.mjs";
import { jsonResultItems, jsonResultItemAt } from "./result-items.mjs";
import { createCodeEditor } from "./code-editor.mjs";
import {
  KnownFields,
  sqlCompletions,
  hasRootProjection,
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
  prepareDocument,
  documentChanges,
} from "./documents.mjs";
import {
  documentFields,
  parseFieldInput,
  editDocumentField,
  buildDocumentPatch,
  documentPathExists,
} from "./fields.mjs";
const $ = (id) => document.getElementById(id);
const state = {
  connectionId: "",
  connectionName: "",
  database: "",
  container: "",
  containers: [],
  savedDatabase: "",
  savedContainer: "",
  readOnly: true,
  busy: false,
  epoch: 0,
  pages: [],
  page: -1,
  snapshot: null,
  baseline: "",
  creating: false,
  documentView: "json",
  preferredDocumentView: "fields",
  fieldErrors: new Map(),
  operation: 0,
  queryJob: null,
  tablePrefs: tablePreferences(),
  tableRevision: 0,
  selectedCell: null,
  selectedRow: null,
  resultStale: false,
};
const host = window.dbxPlugin;
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
  label: "JSON 文档",
  readOnly: true,
  hint: "双击结果行预览，或点击「打开文档」进行编辑",
  diagnostics(error) {
    documentError = error;
    $("json-diagnostic").hidden = !error || state.documentView !== "json";
    $("json-diagnostic").textContent = error?.message || "";
  },
});
const sqlEditor = createCodeEditor($("sql"), {
  label: "SQL 查询",
  language: "sql",
  value: "SELECT * FROM c",
  completion(context) {
    let parameters = [];
    try {
      parameters = parseArray($("parameters").value, "查询参数")
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
const partitionScopes = new Map();
let partitionTarget = "query-pk";
function partitionScope() {
  return JSON.stringify([state.connectionId, state.database, state.container]);
}
function candidates() {
  const key = partitionScope();
  if (!partitionScopes.has(key))
    partitionScopes.set(key, new PartitionCandidates());
  return partitionScopes.get(key);
}
function partitionPaths() {
  return (
    state.containers.find((x) => x.id === state.container)?.partitionKey
      ?.paths || []
  );
}
function rememberKey(text) {
  if (!state.container || !text.trim()) return;
  try {
    candidates().add(text);
  } catch {
    /* Invalid manual input is validated when it is used. */
  }
}
function closePartitionPicker() {
  if (state.container) candidates().loader?.stop();
  $("pk-picker").hidden = true;
  for (const id of ["query-pk-choose", "document-pk-choose"])
    $(id).setAttribute("aria-expanded", "false");
}
function activatePartitionScope() {
  for (const cache of partitionScopes.values()) cache.loader?.stop();
  closePartitionPicker();
  $("query-pk").value = state.container ? candidates().selected || "" : "";
}
function renderPartitionOptions() {
  const cache = candidates(),
    items = cache.filter($("pk-filter").value),
    target = $("pk-options");
  target.replaceChildren();
  let selected = "";
  try {
    selected = encodeJSON(parseArray($(partitionTarget).value, "分区键"));
  } catch {}
  $("pk-count").textContent =
    `匹配 ${items.length} / ${cache.keys.size} 个已知候选`;
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = cache.keys.size
      ? "暂无匹配，仍在加载时请稍候，也可手动输入。"
      : cache.loader?.error
        ? "无法自动获取候选，仍可手动输入分区键。"
        : "正在读取本地缓存或查找分区键…";
    target.append(empty);
  }
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(selected === item.key));
    button.disabled = state.busy;
    button.dataset.key = item.key;
    const label = document.createElement("span");
    label.textContent = item.label;
    const json = document.createElement("code");
    json.textContent = item.key;
    button.append(label, json);
    button.onclick = () => {
      if (state.busy) return;
      $(partitionTarget).value = item.key;
      renderResultSummary();
      if (partitionTarget === "query-pk") cache.selected = item.key;
      else if (state.creating) syncDraftPartition();
      closePartitionPicker();
      $(partitionTarget).focus();
    };
    target.append(button);
  }
  const loader = cache.loader,
    stats = cache.stats.seek,
    done = stats.started && !stats.continuation;
  $("pk-load").textContent = done
    ? "全部已加载"
    : loader?.running
      ? "暂停加载"
      : "继续加载";
  $("pk-load").disabled = state.busy || done || !state.container;
  $("pk-reload").disabled = state.busy || !!loader?.task || !state.container;
  $("pk-clear").disabled = state.busy;
  const ru = Object.values(cache.stats).reduce((sum, s) => sum + s.ru, 0);
  $("pk-progress").textContent = [
    loader?.error || loader?.notice,
    done
      ? `全部分区键已加载 · ${cache.keys.size} 个`
      : loader?.running
        ? `自动加载中 · 已发现 ${cache.keys.size} 个，尚未完成`
        : "已暂停，当前候选尚未加载完整",
    `本次 ${ru.toFixed(2)} RU`,
    cache.cachedAt
      ? `本地缓存：${new Date(cache.cachedAt).toLocaleString()}`
      : "",
    cache.cacheWarning,
  ]
    .filter(Boolean)
    .join(" · ");
  $("pk-progress").classList.toggle("error", !!loader?.error);
}
function openPartitionPicker(target) {
  if (state.busy || !state.container) return;
  partitionTarget = target;
  $("pk-filter").value = "";
  $("pk-title").textContent =
    target === "query-pk" ? "选择查询分区键" : "选择文档分区键";
  $("pk-picker").hidden = false;
  void startPartitionOptions();
  renderPartitionOptions();
  const rect = $(target).getBoundingClientRect(),
    picker = $("pk-picker");
  const width = picker.getBoundingClientRect().width,
    height = picker.getBoundingClientRect().height;
  picker.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
  picker.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - height - 8))}px`;
  $(target + "-choose").setAttribute("aria-expanded", "true");
  $("pk-filter").focus();
}
async function startPartitionOptions(refresh = false) {
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
            cache.cacheWarning = "本地缓存不可用，本次从索引重新加载。";
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
  if (!$("pk-picker").hidden) void cache.loader.start();
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
  $("status").classList.toggle("progress", !!state.queryJob);
  if (!error && !state.queryJob)
    statusTimer = setTimeout(() => {
      $("status").hidden = true;
    }, 4000);
  $("status").textContent = text;
  $("status").title = "";
  $("status").classList.toggle("error", error);
}
function dirty() {
  return (
    !state.readOnly &&
    !!(state.snapshot || state.creating) &&
    (documentEditor.value !== state.baseline || state.fieldErrors.size > 0)
  );
}
function confirmAction(title, message, changes = []) {
  status("等待确认：" + title);
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  const rows = $("change-rows");
  rows.replaceChildren();
  $("confirm-changes").hidden = !changes.length;
  $("confirm-dialog").classList.toggle("has-changes", !!changes.length);
  $("change-count").textContent =
    `${changes.length} 个字段变化${changes.length > 200 ? "（仅显示前 200 项）" : ""}`;
  for (const change of changes.slice(0, 200)) {
    const tr = document.createElement("tr");
    for (const value of [change.path, change.before, change.after]) {
      const td = document.createElement("td");
      td.textContent = value;
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
        if (!confirmed) status("已取消操作");
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
    (await confirmAction("放弃未保存的修改？", "此操作将替换当前文档草稿。"))
  );
}
function controls() {
  const ready = !!state.connectionId,
    selected = !!state.container,
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
    busy || state.readOnly || (!state.snapshot && !state.creating);
  $("scope-container").disabled = busy || !ready || !state.database;
  $("scope-info").disabled = busy || !state.container;
  $("sql-search").disabled = busy || !ready;
  $("document-search").disabled =
    busy || !documentEditor.value.trim() || state.fieldErrors.size > 0;
  $("document-more").disabled = busy || !documentEditor.value.trim();
  if (busy) {
    closeDocumentMenu();
    closeResultItemMenu();
    closeScopePicker();
  }
  documentActions();
  $("document-format").disabled =
    busy || state.readOnly || (!state.snapshot && !state.creating);
  $("previous").disabled = busy || state.page <= 0;
  $("next").disabled = busy || !state.pages[state.page]?.continuation;
  $("run-collapsed").disabled = $("run").disabled;
  $("export").disabled = busy || state.page < 0;
  $("result-filter").disabled = busy || state.page < 0;
  $("copy-cell").disabled = busy || state.selectedCell === null;
  $("copy-row").disabled = busy || state.selectedRow === null;
  resultReaderControls();
  updateFieldChanges();
  $("cancel-query").hidden = !state.queryJob;
  $("save").disabled =
    busy ||
    state.readOnly ||
    (!state.snapshot && !state.creating) ||
    (!!state.snapshot && !dirty()) ||
    state.fieldErrors.size > 0 ||
    !!documentError;
  $("delete").disabled = busy || state.readOnly || !state.snapshot;
  $("new").disabled ||= state.readOnly;
  $("generate-id").hidden = !state.creating;
  $("generate-id").disabled = busy || state.readOnly || !state.creating;
  $("write-hint").textContent = state.readOnly
    ? "当前连接只读。增删改需要可写凭据，并关闭保存连接中的只读设置后重新连接。"
    : state.creating
      ? "已带入当前分区键；可编辑 id 或生成 UUID。保存前会显示字段预览。"
      : "读取完整文档后可修改或删除；保存前显示差异，系统字段不参与编辑。";
  for (const id of ["fields-view", "document-json-view", "field-filter"])
    $(id).disabled = busy || !ready;
  for (const el of $("field-list").querySelectorAll(
    "input,textarea,select,button",
  ))
    el.disabled =
      busy ||
      state.readOnly ||
      (!state.snapshot && !state.creating) ||
      el.dataset.locked === "true";
  for (const id of ["add-field", "add-field-path", "add-field-value"])
    $(id).disabled =
      busy || state.readOnly || (!state.snapshot && !state.creating);
  $("save-method-row").hidden = !state.snapshot;
  $("save-method").disabled = busy || state.readOnly;
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
  status("正在处理…");
  try {
    await fn();
  } catch (error) {
    if (
      epoch === state.epoch &&
      operation === state.operation &&
      error?.message !== "STALE"
    )
      status(error.message || String(error), true);
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
  return result;
}
function scope() {
  if (!state.database || !state.container)
    throw new Error("请先选择数据库和容器");
  return { database: state.database, container: state.container };
}
function metrics(result, prefix = "") {
  status(`${prefix}${result.ru.toFixed(2)} RU · ${result.durationMs} ms`);
  $("status").title = result.activityId
    ? `Activity ID: ${result.activityId}`
    : "";
}
function resetEditor() {
  closeDocumentMenu();
  $("document-location").open = true;
  $("document-identity").textContent = "按 id 与分区键读取";
  $("document-identity").title = "";
  state.fieldErrors.clear();
  state.snapshot = null;
  state.creating = false;
  state.baseline = "";
  documentEditor.value = "";
  $("document-id").value = "";
  $("document-pk").value = "";
  $("document-state").textContent = "未选择";
  $("etag").textContent = "读取完整文档后才能更新或删除。";
  $("field-list").replaceChildren();
  setDocumentView("json");
}
function resetResults() {
  clearSQLError();
  state.resultStale = false;
  state.selectedCell = null;
  state.selectedRow = null;
  $("result-filter").value = "";
  state.pages = [];
  state.page = -1;
  renderPage();
  resetEditor();
}
function options(id, items, placeholder) {
  const el = $(id);
  el.replaceChildren(new Option(placeholder, ""));
  for (const item of items) el.add(new Option(item.id, item.id));
  el.title = el.selectedOptions[0]?.textContent || "";
}
async function listAll(method, params) {
  const items = [];
  let continuation = "";
  const seen = new Set();
  do {
    const p = await invoke(method, { ...params, continuation, pageSize: 100 });
    items.push(...parseJSON(p.json));
    continuation = p.continuation;
    if (continuation && seen.has(continuation))
      throw new Error("服务返回重复分页令牌");
    seen.add(continuation);
  } while (continuation);
  return items;
}
async function loadDatabases() {
  // Preserve a temporary selection on refresh; only reopening restores defaults.
  const database = state.database || state.savedDatabase;
  const container =
    state.container ||
    (database === state.savedDatabase ? state.savedContainer : "");
  databaseChoices = null;
  containerChoices.clear();
  const items = await listAll("cosmos/databases", {
    browse: !!database && database !== state.savedDatabase,
  });
  options("database", items, "选择数据库");
  options("container", [], "选择容器");
  state.database = "";
  state.container = "";
  state.containers = [];
  activatePartitionScope();
  resetResults();
  $("metadata").textContent = "—";
  $("container-info").textContent = `${items.length} 个数据库`;
  updateScopeContext();
  status("已连接，选择数据库和容器。");
  if (database && items.some((item) => item.id === database)) {
    $("database").value = database;
    await selectDatabase(database, { container });
  }
}
async function selectDatabase(next, { container = "", browse = false } = {}) {
  const full =
    browse ||
    next !== state.savedDatabase ||
    (!!container && container !== state.savedContainer);
  let items = [];
  if (next) {
    try {
      items = await listAll("cosmos/containers", {
        database: next,
        browse: full,
      });
    } catch (error) {
      $("database").value = state.database;
      throw error;
    }
  }
  // Commit the switch only after metadata has loaded successfully.
  state.database = next;
  $("database").value = next;
  $("database").title = next;
  state.container = "";
  activatePartitionScope();
  resetResults();
  state.containers = items;
  options("container", items, "选择容器");
  $("metadata").textContent = "—";
  $("container-info").textContent = next
    ? `${items.length} 个容器`
    : "选择容器开始查询";
  if (full && next) containerChoices.set(next, items);
  updateScopeContext();
  status(next ? "请选择容器" : "请选择数据库");
  if (container && items.some((item) => item.id === container)) {
    $("container").value = container;
    selectContainer(container);
  }
}

function selectContainer(next) {
  state.container = next;
  $("container").value = next;
  $("container").title = next;
  activatePartitionScope();
  resetResults();
  void loadTablePreferences();
  const item = state.containers.find((x) => x.id === next);
  $("metadata").textContent = item ? encodeJSON(item, null, 2) : "—";
  $("container-info").textContent = item
    ? `分区路径：${(item.partitionKey?.paths || []).join(", ") || "无"}`
    : "选择容器开始查询";
  updateScopeContext();
  status(next ? "可以运行查询" : "请选择容器");
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
    if (key === preferenceKey()) status("列宽设置仅本次有效（存储不可用）");
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
      if (key === preferenceKey()) status("列宽保存失败；本次仍有效", true);
    });
}
function pageRows() {
  const p = state.pages[state.page];
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
  const unavailable = state.busy || state.page < 0 || !resultEditor;
  $("result-json-search").disabled = unavailable;
  $("copy-results-json").disabled = unavailable;
  $("copy-results-json").title = $("result-filter").value.trim()
    ? "复制当前页筛选后的 JSON（包含所有字段）"
    : "复制当前页全部 JSON（包含所有字段）";
}
function syncResultReader(source) {
  const page = state.pages[state.page],
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
      label: "JSON 查询结果",
      readOnly: true,
      hint: "运行查询后查看当前页 JSON；筛选只影响当前页。",
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
    context.page === state.pages[state.page] &&
    context.filter === $("result-filter").value.trim().toLowerCase() &&
    context.target.connectionId === state.connectionId &&
    context.target.database === state.database &&
    context.target.container === state.container &&
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
  const page = state.pages[state.page];
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
  $("result-item-summary").textContent =
    `${filter ? "筛选结果" : "当前页"}第 ${item.index + 1} 项 · 查询投影`;
  $("read-result-item").disabled = !identity;
  $("result-item-hint").textContent = identity
    ? "复制的是查询投影；打开时按此项自身的 id 和分区键读取完整文档。"
    : paths.length
      ? `缺少可用的字符串 id 或完整分区字段（${paths.join(", ")}），不能打开完整文档；仍可复制此项。`
      : "容器分区路径不可用，不能打开完整文档；仍可复制此项。";
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
  void copyResult(context.json, `第 ${context.index + 1} 项 JSON（查询投影）`);
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
  const p = state.pages[state.page];
  $("query-metrics").title = p?.activityId
    ? `Activity ID: ${p.activityId}`
    : "";
  $("query-metrics").textContent = p
    ? `${p.ru.toFixed(2)} RU · ${p.durationMs} ms`
    : "";
  const changed =
    p &&
    (p.spec.query !== sqlEditor.execution.query ||
      (p.execution?.selected && p.execution.document !== sqlEditor.value) ||
      p.spec.partitionKeyText !== $("query-pk").value.trim() ||
      p.spec.parametersText !== $("parameters").value ||
      p.spec.pageSize !== Number($("page-size").value));
  $("execution-source").hidden = !p?.execution?.selected;
  $("execution-source").textContent = p?.execution?.selected
    ? `选中 SQL · 第 ${p.execution.startLine}${p.execution.endLine !== p.execution.startLine ? "–" + p.execution.endLine : ""} 行`
    : "";
  $("result-origin").hidden = !p;
  $("result-origin").textContent = state.resultStale
    ? "显示上次查询结果"
    : changed
      ? "查询条件已修改"
      : "当前页";
  $("result-origin").classList.toggle("stale", state.resultStale || !!changed);
  $("result-origin").title = p
    ? `${p.spec.query}\n分区键：${p.spec.partitionKeyText || "跨分区"}`
    : "";
}
async function copyResult(text, label) {
  try {
    await host.request("host.copy", { text });
    status(`已复制${label}`);
  } catch {
    status("复制失败，请重试。", true);
  }
}
function renderPage() {
  closeResultItemMenu();
  const p = state.pages[state.page];
  const { all: allRows, filter, rows } = pageRows();
  renderResultSummary();
  $("clear-filter").hidden = !filter;
  $("export").textContent = filter ? "导出筛选结果" : "导出当前页";
  $("export").title = filter
    ? "仅导出当前页匹配筛选的文档（包含所有字段）"
    : "导出当前页所有文档（包含所有字段）";
  $("row-count").textContent = filter
    ? `${rows.length} / ${allRows.length} 条（仅当前页）`
    : `${allRows.length} 条`;
  $("page-label").textContent = `第 ${state.page + 1} 页`;
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
    el.textContent = !p
      ? "选择容器后运行查询"
      : filter && allRows.length
        ? `当前页没有匹配的结果，请清除筛选${p.continuation ? "或查看下一页" : ""}`
        : p.continuation
          ? "当前页为空，仍可读取下一页"
          : "没有匹配的结果";
    if (filter) {
      const clear = document.createElement("button");
      clear.textContent = "清除筛选";
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
  for (const name of ["#", "操作", ...columns]) {
    const col = document.createElement("col");
    const width =
      name === "#"
        ? 48
        : name === "操作"
          ? 96
          : state.tablePrefs.widths[name] || 180;
    col.style.width = `${width}px`;
    colgroup.append(col);
    const th = document.createElement("th");
    th.textContent = name;
    th.style.width = `${width}px`;
    if (name === "id") th.classList.add("pinned-id");
    if (name !== "#" && name !== "操作") {
      const handle = document.createElement("span");
      handle.className = "column-resize";
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-label", `调整 ${name} 列宽`);
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
    $("copy-cell").title = `复制 ${column}（⌘ / Ctrl + C）`;
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
    read.textContent = identity ? "打开文档" : "预览";
    read.type = "button";
    read.className = "row-read";
    read.setAttribute(
      "aria-label",
      identity
        ? `读取第 ${index + 1} 行完整文档`
        : `预览第 ${index + 1} 行查询投影`,
    );
    read.disabled = state.busy;
    read.dataset.available = "true";
    read.title = identity
      ? "按本行 id 和完整分区键读取"
      : `仅预览查询结果；查询需包含 id 和分区字段 ${partitionPaths().join(", ")} 才能直接打开完整文档`;
    read.onclick = (e) => {
      e.stopPropagation();
      if (!identity) {
        void select();
        return;
      }
      showDocument();
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
      td.title = td.textContent;
      if (k === "id") td.classList.add("pinned-id");
      td.tabIndex = index === rows[0]?.index && k === columns[0] ? 0 : -1;
      td.addEventListener("focus", () => selectCell(td, row, k));
      td.addEventListener("click", () => {
        selectCell(td, row, k);
        td.focus({ preventScroll: true });
      });
      td.addEventListener("keydown", (e) => {
        if (
          (e.metaKey || e.ctrlKey) &&
          e.key.toLowerCase() === "c" &&
          !e.altKey
        ) {
          e.preventDefault();
          selectCell(td, row, k);
          void copyResult(state.selectedCell, "单元格");
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
        showDocument();
        resetEditor();
        state.selectedRow = encodeJSON(row, null, 2);
        state.baseline = encodeJSON(row, null, 2);
        documentEditor.value = state.baseline;
        $("document-state").textContent = "查询投影（只读）";
        if (row && typeof row.id === "string") $("document-id").value = row.id;
        const paths =
          state.containers.find((x) => x.id === state.container)?.partitionKey
            ?.paths || [];
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
          status(error.message, true);
          return;
        }
        target
          .querySelectorAll("tr.selected")
          .forEach((x) => x.classList.remove("selected"));
        tr.classList.add("selected");
        controls();
        status("已预览查询结果。确认 id 和分区键后，点击「读取完整文档」。");
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
async function query(next = false) {
  const execution = next
    ? state.pages[state.page]?.execution
    : sqlEditor.execution;
  if (!next) validateSQLExecution(execution);
  if (!(await discard())) return;
  let spec;
  if (next) {
    const p = state.pages[state.page];
    if (!p?.continuation) return;
    spec = { ...p.spec, continuation: p.continuation };
  } else {
    parseArray($("parameters").value, "查询参数");
    if ($("query-pk").value.trim()) parseArray($("query-pk").value, "分区键");
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
  state.queryJob = job;
  state.resultStale = true;
  renderResultSummary();
  const update = () =>
    status(
      `查询执行中 · ${((performance.now() - job.started) / 1000).toFixed(1)} s · 尚未收到结果，RU 未知`,
    );
  update();
  job.timer = setInterval(update, 100);
  controls();
  let result;
  try {
    result = await invoke("cosmos/query", { ...spec, queryId: job.id });
    if (job.canceled || state.queryJob !== job) throw new Error("STALE");
  } catch (error) {
    if (job.canceled || error.message === "STALE") throw new Error("STALE");
    const diagnostic = sqlErrorDiagnostic(execution, sqlEditor.value, error);
    if (diagnostic) {
      setSQLCollapsed(false);
      sqlEditor.setDiagnostic(diagnostic);
      $("sql-diagnostic").textContent = diagnostic.message;
      $("sql-diagnostic").hidden = false;
    }
    throw new Error(
      `查询失败 · ${((performance.now() - job.started) / 1000).toFixed(1)} s · 本次 RU 未知 · ${error.message}`,
    );
  } finally {
    clearInterval(job.timer);
    if (state.queryJob === job) state.queryJob = null;
  }
  rememberKey(spec.partitionKeyText || "");
  learnPartitionKeys(parseJSON(result.json));
  if (hasRootProjection(spec.query))
    for (const doc of parseJSON(result.json)) knownFields().learn(doc);
  if (!next) {
    state.pages = [];
    $("result-filter").value = "";
  } else state.pages = state.pages.slice(0, state.page + 1);
  state.resultStale = false;
  state.pages.push({ ...result, spec, execution });
  state.page = state.pages.length - 1;
  renderPage();
  resetEditor();
  metrics(result, `查询完成 · ${parseJSON(result.json).length} 条 · `);
}
function cancelQuery() {
  const job = state.queryJob;
  if (!job) return;
  job.canceled = true;
  clearInterval(job.timer);
  state.queryJob = null;
  ++state.operation;
  state.busy = false;
  controls();
  const operation = state.operation;
  status("查询已取消；保留上次结果。已产生的 RU 不会退回，本次消耗未知。");
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
        status("已停止接收本次查询结果；后端取消未确认，本次 RU 未知。", true);
    });
}
function point() {
  const id = $("document-id").value;
  if (!id) throw new Error("请输入文档 id");
  parseArray($("document-pk").value, "分区键");
  return { ...scope(), id, partitionKeyText: $("document-pk").value };
}
function opened(result, identity) {
  const doc = parseJSON(result.json),
    etag = result.etag || doc._etag;
  knownFields().learn(doc);
  state.snapshot = { ...identity, etag };
  state.creating = false;
  state.baseline = encodeJSON(editableDocument(doc), null, 2);
  state.fieldErrors.clear();
  documentEditor.value = state.baseline;
  $("document-id").value = identity.id;
  $("document-pk").value = identity.partitionKeyText;
  rememberKey(identity.partitionKeyText);
  $("document-state").textContent = "完整文档";
  $("etag").textContent = etag
    ? `ETag: ${etag}`
    : "服务未提供 ETag，无法更新或删除";
  metrics(result, "文档已读取 · ");
  $("save-method").value = "patch";
  $("field-filter").value = "";
  $("document-location").open = false;
  $("document-identity").textContent = identity.id;
  $("document-identity").title = identity.id;
  $("etag").title = $("etag").textContent;
  setDocumentView(state.preferredDocumentView);
}

let databaseChoices = null;
const containerChoices = new Map();
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
    context.database === state.database
  );
}
async function openScopePicker(kind, refresh = false) {
  if (
    state.busy ||
    !state.connectionId ||
    (kind === "container" && !state.database)
  )
    return;
  closeScopeInfo();
  closeScopePicker();
  const context = (scopePicker = {
    kind,
    trigger: `scope-${kind}`,
    database: state.database,
    connection: state.connectionId,
    epoch: state.epoch,
    items: [],
    loading: true,
    error: "",
  });
  const picker = $("scope-picker");
  $("scope-picker-title").textContent =
    kind === "database" ? "选择数据库" : `选择容器 · ${state.database}`;
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
        ? databaseChoices
        : containerChoices.get(context.database);
    if (refresh || !items) {
      items = await listAll(
        kind === "database" ? "cosmos/databases" : "cosmos/containers",
        { database: context.database, browse: true },
      );
      if (!liveScopePicker(context)) return;
      if (kind === "database") databaseChoices = items;
      else containerChoices.set(context.database, items);
    }
    if (!liveScopePicker(context)) return;
    context.items = items;
  } catch (error) {
    if (!liveScopePicker(context)) return;
    context.error = error.message || "列表加载失败，请重试";
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
  $("scope-picker-status").textContent = context.loading
    ? "正在加载列表…"
    : context.error || `${items.length} / ${context.items.length} 项`;
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "scope-empty";
    empty.textContent = context.loading
      ? "请稍候"
      : context.error
        ? "无法加载列表，可点击刷新重试。当前范围保持不变。"
        : needle
          ? "没有匹配的名称"
          : "没有可选项";
    target.append(empty);
  }
  const selected =
    context.kind === "database" ? state.database : state.container;
  for (const item of items) {
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(item.id === selected));
    option.textContent = item.id;
    option.title = item.id;
    option.onclick = () => chooseScope(context, item.id);
    target.append(option);
  }
}
async function chooseScope(context, id) {
  if (!liveScopePicker(context) || state.busy) return;
  const same =
    id === (context.kind === "database" ? state.database : state.container);
  closeScopePicker(true);
  if (same) return;
  let switched = false;
  await action(async () => {
    if (!(await discard()) || context.epoch !== state.epoch) return;
    await pauseDiscovery();
    if (context.kind === "database") {
      options("database", context.items, "选择数据库");
      $("database").value = id;
      await selectDatabase(id, { browse: true });
    } else {
      state.containers = context.items;
      options("container", context.items, "选择容器");
      selectContainer(id);
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
  const scoped = !!(state.savedDatabase && state.savedContainer);
  document.body.classList.toggle("container-scoped", scoped);
  $("scope-context").hidden = !scoped;
  $("scope-panel-title").textContent = scoped ? "容器信息" : "数据库与容器";
  $("scope-panel").setAttribute(
    "aria-label",
    scoped ? "容器信息" : "数据库与容器",
  );
  $("refresh").title = scoped ? "刷新容器元数据" : "刷新数据库列表";
  $("refresh").setAttribute("aria-label", $("refresh").title);
  for (const [id, value] of [
    ["scope-connection", state.connectionName],
    ["scope-database", state.database || state.savedDatabase || "选择数据库"],
    [
      "scope-container",
      state.container ||
        (state.database ? "选择容器" : state.savedContainer) ||
        "选择容器",
    ],
  ]) {
    $(id).textContent = value;
    $(id).title = value;
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
  const text = state.snapshot || state.creating ? documentEditor.value : "{}";
  const baseline = state.baseline || "{}";
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
    !(state.snapshot || state.creating) ||
    (!changes.length && !state.fieldErrors.size && !documentError);
  summary.textContent =
    state.fieldErrors.size || documentError
      ? "草稿格式有误，请先修正"
      : `已修改 ${changes.length} 个字段`;
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
  $("document-state").textContent = dirty()
    ? "未保存"
    : state.creating
      ? "新文档"
      : "完整文档";
  controls();
}
function setDocumentView(view) {
  if (state.fieldErrors.size && view !== state.documentView) {
    status("请先修正字段值格式，再切换视图。", true);
    return;
  }
  if (view === "fields") {
    try {
      renderFields();
    } catch (error) {
      status(
        "JSON 文档格式不正确，请先在 JSON 视图修正：" + error.message,
        true,
      );
      return;
    }
  }
  state.documentView = view;
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
    title.title = row.path;
    const kind = document.createElement("span");
    kind.className = "field-kind";
    kind.textContent = row.locked
      ? "只读"
      : { string: "文本", number: "数字", boolean: "布尔", json: "JSON" }[
          row.kind
        ];
    const marker = document.createElement("span");
    marker.className = "field-change";
    marker.textContent = "已修改";
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
    input.setAttribute("aria-label", `字段 ${row.path}`);
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
        state.fieldErrors.delete(row.path);
        error.textContent = "";
        input.removeAttribute("aria-invalid");
        draftChanged();
      } catch (e) {
        state.fieldErrors.set(row.path, e.message);
        error.textContent = e.message;
        input.setAttribute("aria-invalid", "true");
        controls();
      }
    };
    const remove = document.createElement("button");
    remove.type = "button";
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg>';
    remove.title = `删除字段 ${row.path}`;
    remove.className = "remove-field icon-button";
    remove.dataset.locked = String(row.locked);
    remove.setAttribute("aria-label", `删除字段 ${row.path}`);
    remove.onclick = () => {
      if (state.busy || state.readOnly || row.locked) return;
      if ([...state.fieldErrors.keys()].some((path) => path !== row.path)) {
        status("请先修正其他字段的无效值，再删除字段。", true);
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
        state.fieldErrors.delete(row.path);
        renderFields();
        draftChanged();
      } catch (error) {
        status(error.message, true);
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
    empty.textContent = "没有匹配的字段。";
    target.append(empty);
  }
}
$("document-search").onclick = () => {
  if (state.fieldErrors.size) {
    status("请先修正字段值格式，再搜索 JSON。", true);
    return;
  }
  setDocumentView("json");
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
  $("document-fold").title = invalid
    ? "请先修正 JSON"
    : documentEditor.nestedFoldCount
      ? "收起嵌套对象与数组，保留顶层字段"
      : "当前文档没有可折叠的嵌套对象或数组";
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
$("sql-search").onclick = () => sqlEditor.search();
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
  $("document-expand").textContent = expanded ? "还原" : "放大";
  $("document-expand").title = expanded ? "还原文档面板" : "放大文档面板";
  $("document-expand").setAttribute("aria-pressed", String(expanded));
  documentEditor.measure();
  sqlEditor.measure();
};
window.addEventListener("resize", () =>
  resizeDocument(Number(separator.getAttribute("aria-valuenow"))),
);
$("fields-view").onclick = () => {
  setDocumentView("fields");
  if (state.documentView === "fields") state.preferredDocumentView = "fields";
};
$("document-json-view").onclick = () => {
  setDocumentView("json");
  if (state.documentView === "json") state.preferredDocumentView = "json";
};
$("field-filter").oninput = () => {
  if (state.fieldErrors.size) {
    status("请先修正无效字段值，再筛选。", true);
    return;
  }
  try {
    renderFields();
    controls();
  } catch (error) {
    status(error.message, true);
  }
};
$("add-field").onclick = () => {
  if (state.busy || state.readOnly || (!state.snapshot && !state.creating))
    return;
  try {
    if (state.fieldErrors.size) throw new Error("请先修正无效字段值。");
    const path = $("add-field-path").value.trim(),
      doc = parseJSON(documentEditor.value);
    if (documentPathExists(doc, path))
      throw new Error("字段已存在，请直接编辑对应字段。");
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
    status(error.message, true);
  }
};

function syncDraftPartition() {
  if (!state.creating) return;
  try {
    const doc = applyDocumentPartition(
      editableDocument(parseJSON(documentEditor.value)),
      $("document-pk").value,
      partitionPaths(),
    );
    documentEditor.value = encodeJSON(doc, null, 2);
    $("document-id").value = doc.id || "";
    controls();
  } catch (error) {
    status(error.message, true);
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
    notes.push("分区键缓存读取失败");
  }
  const previousPage = state.pages[state.page];
  const previous = previousPage?.spec;
  if (previous) {
    const spec = { ...previous };
    delete spec.continuation;
    try {
      const refreshed = await invoke("cosmos/query", spec);
      state.resultStale = false;
      state.pages = [{ ...refreshed, spec, execution: previousPage.execution }];
      state.page = 0;
      renderPage();
      notes.push(`上次查询已刷新至第 1 页（${refreshed.ru.toFixed(2)} RU）`);
    } catch (error) {
      if (error.message === "STALE") throw error;
      state.pages = [];
      state.page = -1;
      renderPage();
      notes.push(`查询刷新失败，请手动运行：${error.message}`);
    }
  }
  if (result.cacheWarning) notes.push(result.cacheWarning);
  status(
    `${verb}成功 · ${result.ru.toFixed(2)} RU${notes.length ? " · " + notes.join("；") : ""}`,
  );
}
function view(json) {
  closeResultItemMenu();
  $("table").hidden = json;
  $("raw-results").hidden = !json;
  $("table-view").classList.toggle("active", !json);
  $("table-view").setAttribute("aria-pressed", String(!json));
  $("json-view").setAttribute("aria-pressed", String(json));
  $("json-view").classList.toggle("active", json);
  $("table-tools").hidden = json;
  $("result-json-tools").hidden = !json;
  if (json) syncResultReader();
}
const bind = (id, fn) => $(id).addEventListener("click", () => action(fn));
bind("refresh", async () => {
  if (await discard()) await loadDatabases();
});
$("database").addEventListener("change", () =>
  action(async () => {
    const next = $("database").value;
    if (!(await discard())) {
      $("database").value = state.database;
      return;
    }
    await selectDatabase(next);
  }),
);
$("container").addEventListener("change", () =>
  action(async () => {
    const next = $("container").value;
    if (!(await discard())) {
      $("container").value = state.container;
      return;
    }
    selectContainer(next);
  }),
);
bind("run", () => query());
bind("run-collapsed", () => query());
$("cancel-query").onclick = cancelQuery;
$("result-filter").oninput = renderPage;
$("clear-filter").onclick = () => {
  $("result-filter").value = "";
  renderPage();
  $("result-filter").focus();
};
$("copy-cell").onclick = () => {
  if (state.selectedCell !== null)
    void copyResult(state.selectedCell, "单元格");
};
$("copy-row").onclick = () => {
  if (state.selectedRow !== null)
    void copyResult(state.selectedRow, "行 JSON（查询投影）");
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
$("query-pk-choose").onclick = () => openPartitionPicker("query-pk");
$("document-pk-choose").onclick = () => openPartitionPicker("document-pk");
$("pk-close").onclick = () => closePartitionPicker();
$("pk-clear").onclick = () => {
  if (!state.busy) {
    $(partitionTarget).value = "";
    renderResultSummary();
    if (partitionTarget === "query-pk") candidates().selected = "";
    closePartitionPicker();
    $(partitionTarget).focus();
  }
};
$("pk-filter").oninput = renderPartitionOptions;
$("pk-filter").onkeydown = (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    $("pk-options").querySelector("button:not(:disabled)")?.focus();
  }
};
$("pk-options").onkeydown = (e) => {
  const buttons = [
      ...$("pk-options").querySelectorAll("button:not(:disabled)"),
    ],
    index = buttons.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    buttons[
      (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
        buttons.length
    ]?.focus();
  }
};
document.addEventListener("pointerdown", (e) => {
  if (
    !$("pk-picker").hidden &&
    !$("pk-picker").contains(e.target) &&
    !e.target.closest("#query-pk-choose,#document-pk-choose")
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
  if (state.container) {
    rememberKey($("query-pk").value);
    candidates().selected = $("query-pk").value;
  }
});
bind("next", () => query(true));
bind("previous", async () => {
  if (await discard()) {
    state.page--;
    renderPage();
    resetEditor();
    metrics(state.pages[state.page]);
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
  state.creating = true;
  state.baseline = encodeJSON(doc, null, 2);
  documentEditor.value = state.baseline;
  $("document-id").value = doc.id;
  $("document-pk").value = key;
  $("document-state").textContent = "新文档";
  $("etag").textContent =
    "新文档使用创建操作；同 id 与分区键已存在时会报冲突，不会覆盖。";
  status("正在编辑新文档");
});
bind("save", async () => {
  if (state.fieldErrors.size) throw new Error("请先修正字段值格式。");
  const text = documentEditor.value;
  const prepared = prepareDocument(
    text,
    $("document-pk").value,
    partitionPaths(),
    state.creating ? null : state.snapshot,
  );
  const doc = prepared.doc;
  const creating = state.creating,
    identity = creating
      ? { ...scope(), id: doc.id, partitionKeyText: prepared.partitionKeyText }
      : state.snapshot;
  parseArray(identity.partitionKeyText, "分区键");
  if (
    !creating &&
    (doc.id !== identity.id || $("document-id").value !== identity.id)
  )
    throw new Error("更新时不能更改 id 或分区键，请重新读取文档");
  const changes = documentChanges(
    creating ? {} : parseJSON(state.baseline),
    doc,
  );
  if (!changes.length) {
    status("没有需要保存的字段变化。");
    return;
  }
  const patch = !creating && $("save-method").value === "patch";
  const operations = patch
    ? buildDocumentPatch(parseJSON(state.baseline), doc, partitionPaths())
    : null;
  if (
    !(await confirmAction(
      creating ? "创建文档？" : patch ? "局部更新文档？" : "替换完整文档？",
      `${identity.database} / ${identity.container}\nid: ${identity.id}\n分区键: ${identity.partitionKeyText}${patch ? `\n仅提交 ${operations.length} 个字段操作` : ""}`,
      changes,
    ))
  )
    return;
  await pauseDiscovery();
  const result = await invoke(
    creating ? "cosmos/create" : patch ? "cosmos/patch" : "cosmos/replace",
    {
      ...identity,
      ...(patch
        ? { operationsText: encodeJSON(operations) }
        : { documentText: prepared.text }),
    },
  );
  opened(result, identity);
  await afterMutation(result, identity, "保存");
});
bind("delete", async () => {
  if (dirty()) throw new Error("当前有未保存修改，请先保存或重新读取文档");
  const identity = state.snapshot;
  if (!identity) throw new Error("请先读取完整文档");
  if (
    !(await confirmAction(
      "永久删除文档？",
      `${identity.database} / ${identity.container}\nid: ${identity.id}\n分区键: ${identity.partitionKeyText}\n此操作无法撤销。`,
      documentChanges(parseJSON(state.baseline), {}),
    ))
  )
    return;
  await pauseDiscovery();
  const result = await invoke("cosmos/delete", identity);
  resetEditor();
  await afterMutation(result, identity, "删除");
});
bind("export", async () => {
  const p = state.pages[state.page];
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
    throw new Error("当前页超过 1 MiB，请减小每页数量后导出");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const result = await host.request("host.saveFile", {
    fileName: `${state.container}-page-${state.page + 1}${filter ? "-filtered" : ""}.json`,
    contentType: "application/json",
    dataBase64: btoa(binary),
  });
  status(result ? "当前页已导出" : "已取消导出");
});
$("table-view").onclick = () => view(false);
$("json-view").onclick = () => view(true);
$("result-json-search").onclick = () => {
  if (resultEditor && !state.busy) resultEditor.search();
};
$("copy-results-json").onclick = () => {
  if (!resultEditor || state.busy || state.page < 0) return;
  void copyResult(
    resultEditor.value,
    $("result-filter").value.trim() ? "当前页筛选结果 JSON" : "当前页 JSON",
  );
};
documentEditor.onChange(() => {
  $("document-state").textContent = dirty()
    ? "未保存"
    : state.creating
      ? "新文档"
      : "完整文档";
  if (state.creating) {
    try {
      $("document-id").value = parseJSON(documentEditor.value).id || "";
    } catch {}
  }
  controls();
});
$("document-pk").addEventListener("input", () => {
  try {
    parseArray($("document-pk").value, "分区键");
  } catch {
    return;
  }
  syncDraftPartition();
});
$("document-id").addEventListener("input", () => {
  if (!state.creating) return;
  try {
    const doc = editableDocument(parseJSON(documentEditor.value));
    doc.id = $("document-id").value;
    documentEditor.value = encodeJSON(doc, null, 2);
    controls();
  } catch (error) {
    status(error.message, true);
  }
});
bind("generate-id", async () => {
  const doc = editableDocument(parseJSON(documentEditor.value));
  doc.id = crypto.randomUUID();
  const paths = partitionPaths();
  if (paths.includes("/id")) {
    const values = parseArray($("document-pk").value, "分区键");
    values[paths.indexOf("/id")] = doc.id;
    $("document-pk").value = encodeJSON(values);
  }
  documentEditor.value = encodeJSON(doc, null, 2);
  $("document-id").value = doc.id;
  status("已生成新的文档 UUID。");
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
  if (state.queryJob) cancelQuery();
  for (const cache of partitionScopes.values()) cache.loader?.stop();
  partitionScopes.clear();
  fieldScopes.clear();
  if ($("confirm-dialog").open) $("confirm-dialog").close("cancel");
  state.epoch++;
  state.connectionId = id;
  state.database = "";
  state.container = "";
  activatePartitionScope();
  state.readOnly = true;
  state.savedDatabase = "";
  state.savedContainer = "";
  databaseChoices = null;
  containerChoices.clear();
  updateScopeContext();
  resetResults();
  options("database", [], "选择数据库");
  options("container", [], "选择容器");
  state.connectionName =
    context?.connection?.name || context?.connectionName || context?.name || "";
  $("connection-name").textContent =
    state.connectionName ||
    (id ? "已连接到 Azure Cosmos DB" : "从 DBX 打开已保存的 Cosmos DB 连接");
  if (!id) {
    $("mode").textContent = "未连接";
    status("请从 DBX 连接列表打开已保存的 Cosmos DB 连接。");
    controls();
    return;
  }
  // Context switches invalidate all earlier RPC responses before initializing the new view.
  state.busy = false;
  await action(async () => {
    const info = await invoke("cosmos/info");
    state.readOnly = info.readOnly;
    state.savedDatabase = info.database || "";
    state.savedContainer = info.container || "";
    updateScopeContext();
    $("mode").textContent = info.readOnly ? "只读连接" : "允许文档写入";
    await loadDatabases();
  });
}
controls();
if (host) {
  host.onContext(contextChanged);
  host.ready
    .then((context) => {
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
    .catch((e) => status(e.message, true));
} else status("此工作台需要在 DBX 插件宿主中打开。", true);

function clearSQLError() {
  sqlEditor.setDiagnostic(null);
  $("sql-diagnostic").hidden = true;
}
function updateSQLExecution() {
  const selected = sqlEditor.execution.selected;
  const label = selected ? "运行选中 SQL" : "运行查询";
  for (const id of ["run", "run-collapsed"]) {
    $(id).textContent = label;
    $(id).title = selected
      ? "只执行 SQL 编辑器中的选中内容（⌘ / Ctrl + Enter）"
      : "执行 SQL 编辑器全文（⌘ / Ctrl + Enter）";
  }
  renderResultSummary();
}
sqlEditor.onChange(() => {
  $("sql-diagnostic").hidden = true;
});
sqlEditor.onSelection(updateSQLExecution);
updateSQLExecution();
$("sql-diagnostic").onclick = () => sqlEditor.focusError();
for (const id of ["query-pk", "parameters", "page-size"]) {
  $(id).addEventListener("input", renderResultSummary);
  $(id).addEventListener("change", renderResultSummary);
}
function setSQLCollapsed(collapsed) {
  $("query-body").hidden = collapsed;
  $("run-collapsed").hidden = !collapsed;
  $("query-collapse").textContent = collapsed ? "展开 SQL" : "收起 SQL";
  $("query-collapse").setAttribute("aria-expanded", String(!collapsed));
  if (!collapsed) sqlEditor.measure();
}
$("query-collapse").onclick = () => setSQLCollapsed(!$("query-body").hidden);
function showDocument() {
  workspace.classList.remove("document-hidden");
  $("document-toggle").textContent = "收起文档";
  $("document-toggle").setAttribute("aria-expanded", "true");
  documentEditor.measure();
}
$("document-toggle").onclick = () => {
  if (workspace.classList.contains("document-hidden")) showDocument();
  else {
    workspace.classList.add("document-hidden");
    $("document-toggle").textContent = "展开文档";
    $("document-toggle").setAttribute("aria-expanded", "false");
  }
  sqlEditor.measure();
};
