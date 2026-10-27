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
};
const host = window.dbxPlugin;
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
  hint: "点击结果行预览，再读取完整文档进行编辑",
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
function status(text, error = false) {
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
    "document-id",
    "document-pk",
  ])
    $(id).disabled = busy || !ready;
  for (const id of ["run", "read", "new"]) $(id).disabled = busy || !selected;
  sqlEditor.readOnly = busy || !ready;
  documentEditor.readOnly =
    busy || state.readOnly || (!state.snapshot && !state.creating);
  $("sql-search").disabled = busy || !ready;
  $("document-search").disabled =
    busy || !documentEditor.value.trim() || state.fieldErrors.size > 0;
  $("document-more").disabled = busy || !documentEditor.value.trim();
  if (busy) closeDocumentMenu();
  documentActions();
  $("document-format").disabled =
    busy || state.readOnly || (!state.snapshot && !state.creating);
  $("previous").disabled = busy || state.page <= 0;
  $("next").disabled = busy || !state.pages[state.page]?.continuation;
  $("export").disabled = busy || state.page < 0;
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
}
async function action(fn) {
  if (state.busy) return;
  const epoch = state.epoch;
  state.busy = true;
  controls();
  status("正在处理…");
  try {
    await fn();
  } catch (error) {
    if (epoch === state.epoch && error?.message !== "STALE")
      status(error.message || String(error), true);
  } finally {
    if (epoch === state.epoch) {
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
  state.pages = [];
  state.page = -1;
  renderPage();
  resetEditor();
}
function options(id, items, placeholder) {
  const el = $(id);
  el.replaceChildren(new Option(placeholder, ""));
  for (const item of items) el.add(new Option(item.id, item.id));
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
  const items = await listAll("cosmos/databases", {});
  options("database", items, "选择数据库");
  options("container", [], "选择容器");
  state.database = "";
  state.container = "";
  state.containers = [];
  activatePartitionScope();
  resetResults();
  $("metadata").textContent = "—";
  $("container-info").textContent = `${items.length} 个数据库`;
  status("已连接，选择数据库和容器。");
  if (state.savedDatabase) {
    $("database").value = state.savedDatabase;
    await selectDatabase(state.savedDatabase);
    $("container").value = state.savedContainer;
    selectContainer(state.savedContainer);
  }
}

async function selectDatabase(next) {
  state.database = next;
  state.container = "";
  activatePartitionScope();
  resetResults();
  options("container", [], "选择容器");
  state.containers = [];
  $("metadata").textContent = "—";
  if (!next) {
    status("请选择数据库");
    return;
  }
  const items = await listAll("cosmos/containers", { database: next });
  state.containers = items;
  options("container", items, "选择容器");
  $("container-info").textContent = `${items.length} 个容器`;
  status("请选择容器");
}
function selectContainer(next) {
  state.container = next;
  activatePartitionScope();
  resetResults();
  const item = state.containers.find((x) => x.id === next);
  $("metadata").textContent = item ? encodeJSON(item, null, 2) : "—";
  $("container-info").textContent = item
    ? `分区路径：${(item.partitionKey?.paths || []).join(", ") || "无"}`
    : "选择容器开始查询";
  status("可以运行查询");
}
function renderPage() {
  const p = state.pages[state.page];
  const rows = p ? parseJSON(p.json) : [];
  $("row-count").textContent = `${rows.length} 条`;
  $("page-label").textContent = `第 ${state.page + 1} 页`;
  $("raw-results").value = p ? formatJSON(p.json) : "";
  const target = $("table");
  target.replaceChildren();
  if (!rows.length) {
    const el = document.createElement("div");
    el.className = "empty";
    el.textContent = p
      ? p.continuation
        ? "当前页为空，仍可读取下一页"
        : "没有匹配的结果"
      : "选择容器后运行查询";
    target.append(el);
    return;
  }
  const columns = columnsFor(rows),
    table = document.createElement("table"),
    thead = table.createTHead(),
    tr = thead.insertRow();
  for (const name of ["#", ...columns]) {
    const th = document.createElement("th");
    th.textContent = name;
    tr.append(th);
  }
  const tbody = table.createTBody();
  rows.forEach((row, index) => {
    const tr = tbody.insertRow();
    tr.tabIndex = 0;
    for (const value of [
      index + 1,
      ...columns.map((k) => (k === "(value)" ? row : row?.[k])),
    ]) {
      const td = tr.insertCell();
      td.textContent =
        typeof value === "object" ? encodeJSON(value) : String(value ?? "");
      td.title = td.textContent;
    }
    const select = () =>
      action(async () => {
        if (!(await discard())) return;
        resetEditor();
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
        status("已预览查询结果。确认 id 和分区键后，点击「读取完整文档」。");
      });
    tr.addEventListener("click", select);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter") select();
    });
  });
  target.append(table);
}
async function query(next = false) {
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
      query: sqlEditor.value,
      parametersText: $("parameters").value,
      partitionKeyText: $("query-pk").value.trim(),
      pageSize: Number($("page-size").value),
    };
  }
  const result = await invoke("cosmos/query", spec);
  rememberKey(spec.partitionKeyText || "");
  learnPartitionKeys(parseJSON(result.json));
  if (hasRootProjection(spec.query))
    for (const doc of parseJSON(result.json)) knownFields().learn(doc);
  if (!next) state.pages = [];
  else state.pages = state.pages.slice(0, state.page + 1);
  state.pages.push({ ...result, spec });
  state.page = state.pages.length - 1;
  renderPage();
  resetEditor();
  metrics(result);
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
    title.textContent = row.path + (row.locked ? " · 只读" : "");
    const input =
      row.kind === "boolean"
        ? document.createElement("select")
        : document.createElement(
            row.kind === "json" ||
              (row.kind === "string" && String(row.value).length > 80)
              ? "textarea"
              : "input",
          );
    if (row.kind === "boolean")
      for (const value of ["true", "false"])
        input.add(new Option(value, value));
    if (input.tagName === "TEXTAREA") input.rows = 3;
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
    remove.textContent = "删除字段";
    remove.className = "remove-field";
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
    label.append(title, input);
    card.append(label, error, remove);
    target.append(card);
  }
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
  const previous = state.pages[state.page]?.spec;
  if (previous) {
    const spec = { ...previous };
    delete spec.continuation;
    try {
      const refreshed = await invoke("cosmos/query", spec);
      state.pages = [{ ...refreshed, spec }];
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
  $("table").hidden = json;
  $("raw-results").hidden = !json;
  $("table-view").classList.toggle("active", !json);
  $("table-view").setAttribute("aria-pressed", String(!json));
  $("json-view").setAttribute("aria-pressed", String(json));
  $("json-view").classList.toggle("active", json);
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
  const bytes = new TextEncoder().encode(p.json);
  if (bytes.length > 1024 * 1024)
    throw new Error("当前页超过 1 MiB，请减小每页数量后导出");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const result = await host.request("host.saveFile", {
    fileName: `${state.container}-page-${state.page + 1}.json`,
    contentType: "application/json",
    dataBase64: btoa(binary),
  });
  status(result ? "当前页已导出" : "已取消导出");
});
$("table-view").onclick = () => view(false);
$("json-view").onclick = () => view(true);
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
document.addEventListener("keydown", (e) => {
  if (
    (e.metaKey || e.ctrlKey) &&
    e.key === "Enter" &&
    !e.isComposing &&
    e.target.closest(".query-panel") &&
    !$("confirm-dialog").open
  ) {
    e.preventDefault();
    if (!$("run").disabled) $("run").click();
  }
});
async function contextChanged(context) {
  const id = context?.connectionId || context?.connection?.id || "";
  if (id === state.connectionId) return;
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
  resetResults();
  options("database", [], "选择数据库");
  options("container", [], "选择容器");
  $("connection-name").textContent =
    context?.connection?.name ||
    context?.connectionName ||
    context?.name ||
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
