import {
  keyFromDocument,
  parseArray,
  columnsFor,
  formatJSON,
  parseJSON,
  encodeJSON,
} from "./model.mjs";
const $ = (id) => document.getElementById(id);
const state = {
  connectionId: "",
  database: "",
  container: "",
  containers: [],
  readOnly: true,
  busy: false,
  epoch: 0,
  pages: [],
  page: -1,
  snapshot: null,
  baseline: "",
  creating: false,
};
const host = window.dbxPlugin;
$("confirm-cancel").onclick = () => $("confirm-dialog").close("cancel");
$("confirm-accept").onclick = () => $("confirm-dialog").close("confirm");
function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
function dirty() {
  return (
    !state.readOnly &&
    !!(state.snapshot || state.creating) &&
    $("editor").value !== state.baseline
  );
}
function confirmAction(title, message) {
  status("等待确认：" + title);
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
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
    "sql",
    "query-pk",
    "page-size",
    "parameters",
    "document-id",
    "document-pk",
  ])
    $(id).disabled = busy || !ready;
  for (const id of ["run", "read", "new"]) $(id).disabled = busy || !selected;
  $("previous").disabled = busy || state.page <= 0;
  $("next").disabled = busy || !state.pages[state.page]?.continuation;
  $("export").disabled = busy || state.page < 0;
  $("save").disabled =
    busy || state.readOnly || (!state.snapshot && !state.creating);
  $("delete").disabled = busy || state.readOnly || !state.snapshot;
  $("new").disabled ||= state.readOnly;
  $("editor").readOnly =
    busy || state.readOnly || (!state.snapshot && !state.creating);
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
  status(
    `${prefix}${result.ru.toFixed(2)} RU · ${result.durationMs} ms${result.activityId ? " · Activity: " + result.activityId : ""}`,
  );
}
function resetEditor() {
  state.snapshot = null;
  state.creating = false;
  state.baseline = "";
  $("editor").value = "";
  $("document-id").value = "";
  $("document-pk").value = "";
  $("document-state").textContent = "未选择";
  $("etag").textContent = "读取完整文档后才能更新或删除。";
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
  resetResults();
  $("metadata").textContent = "—";
  $("container-info").textContent = `${items.length} 个数据库`;
  status("已连接，选择数据库和容器。");
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
        $("editor").value = state.baseline;
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
      query: $("sql").value,
      parametersText: $("parameters").value,
      partitionKeyText: $("query-pk").value.trim(),
      pageSize: Number($("page-size").value),
    };
  }
  const result = await invoke("cosmos/query", spec);
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
  state.snapshot = { ...identity, etag };
  state.creating = false;
  state.baseline = formatJSON(result.json);
  $("editor").value = state.baseline;
  $("document-id").value = identity.id;
  $("document-pk").value = identity.partitionKeyText;
  $("document-state").textContent = "完整文档";
  $("etag").textContent = etag
    ? `ETag: ${etag}`
    : "服务未提供 ETag，无法更新或删除";
  metrics(result, "文档已读取 · ");
}
function view(json) {
  $("table").hidden = json;
  $("raw-results").hidden = !json;
  $("table-view").classList.toggle("active", !json);
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
    state.database = next;
    state.container = "";
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
  }),
);
$("container").addEventListener("change", () =>
  action(async () => {
    const next = $("container").value;
    if (!(await discard())) {
      $("container").value = state.container;
      return;
    }
    state.container = next;
    resetResults();
    const item = state.containers.find((x) => x.id === next);
    $("metadata").textContent = item ? encodeJSON(item, null, 2) : "—";
    $("container-info").textContent = item
      ? `分区路径：${(item.partitionKey?.paths || []).join(", ") || "无"}`
      : "选择容器开始查询";
    status("可以运行查询");
  }),
);
bind("run", () => query());
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
  resetEditor();
  state.creating = true;
  state.baseline = '{\n  "id": ""\n}';
  $("editor").value = state.baseline;
  $("document-state").textContent = "新文档";
  $("etag").textContent = "填写 JSON（含 id）及完整分区键后保存。";
  status("正在编辑新文档");
});
bind("save", async () => {
  const text = $("editor").value;
  const doc = parseJSON(text);
  if (!doc || Array.isArray(doc) || typeof doc.id !== "string" || !doc.id)
    throw new Error("文档必须是包含字符串 id 的 JSON 对象");
  const creating = state.creating,
    identity = creating
      ? { ...scope(), id: doc.id, partitionKeyText: $("document-pk").value }
      : state.snapshot;
  parseArray(identity.partitionKeyText, "分区键");
  if (
    !creating &&
    (doc.id !== identity.id ||
      $("document-pk").value !== identity.partitionKeyText ||
      $("document-id").value !== identity.id)
  )
    throw new Error("更新时不能更改 id 或分区键，请重新读取文档");
  if (
    !(await confirmAction(
      creating ? "创建文档？" : "替换完整文档？",
      `${identity.database} / ${identity.container}\nid: ${identity.id}\n分区键: ${identity.partitionKeyText}`,
    ))
  )
    return;
  const result = await invoke(creating ? "cosmos/create" : "cosmos/replace", {
    ...identity,
    documentText: text,
  });
  opened(result, identity);
  status("保存成功。查询结果为旧快照，可重新运行查询刷新。");
});
bind("delete", async () => {
  if (dirty()) throw new Error("当前有未保存修改，请先保存或重新读取文档");
  const identity = state.snapshot;
  if (!identity) throw new Error("请先读取完整文档");
  if (
    !(await confirmAction(
      "永久删除文档？",
      `${identity.database} / ${identity.container}\nid: ${identity.id}\n分区键: ${identity.partitionKeyText}\n此操作无法撤销。`,
    ))
  )
    return;
  const result = await invoke("cosmos/delete", identity);
  resetEditor();
  metrics(result, "删除成功。重新运行查询可刷新结果 · ");
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
$("editor").addEventListener("input", () => {
  $("document-state").textContent = dirty()
    ? "未保存"
    : state.creating
      ? "新文档"
      : "完整文档";
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (!$("run").disabled) $("run").click();
  }
});
async function contextChanged(context) {
  const id = context?.connectionId || context?.connection?.id || "";
  if (id === state.connectionId) return;
  if ($("confirm-dialog").open) $("confirm-dialog").close("cancel");
  state.epoch++;
  state.connectionId = id;
  state.database = "";
  state.container = "";
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
