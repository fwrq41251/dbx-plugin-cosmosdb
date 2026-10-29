import { parseJSON, encodeJSON } from "./model.mjs";
import {
  t,
  message as msg,
  LocalizedError,
  setText,
  setAttr,
} from "./i18n.mjs";

export function createScopeState() {
  return {
    database: "",
    container: "",
    containers: [],
    savedDatabase: "",
    savedContainer: "",
    databaseChoices: null,
    containerChoices: new Map(),
  };
}

export function createScopeController(dependencies) {
  const {
    scopeState,
    $,
    invoke,
    options,
    activatePartitionScope,
    resetResults,
    updateScopeContext,
    status,
    loadTablePreferences,
    loadQueryInputs,
  } = dependencies;
  async function listAll(method, params) {
    const items = [];
    let continuation = "";
    const seen = new Set();
    do {
      const p = await invoke(method, {
        ...params,
        continuation,
        pageSize: 100,
      });
      items.push(...parseJSON(p.json));
      continuation = p.continuation;
      if (continuation && seen.has(continuation))
        throw new LocalizedError(
          msg("ui.theServiceReturnedARepeatedContinuationToken"),
        );
      seen.add(continuation);
    } while (continuation);
    return items;
  }
  async function loadDatabases() {
    // Preserve a temporary selection on refresh; only reopening restores defaults.
    const database = scopeState.database || scopeState.savedDatabase;
    const container =
      scopeState.container ||
      (database === scopeState.savedDatabase ? scopeState.savedContainer : "");
    scopeState.databaseChoices = null;
    scopeState.containerChoices.clear();
    const items = await listAll("cosmos/databases", {
      browse: !!database && database !== scopeState.savedDatabase,
    });
    options("database", items, msg("scope.selectDatabase"));
    options("container", [], msg("scope.selectContainer"));
    scopeState.database = "";
    scopeState.container = "";
    scopeState.containers = [];
    activatePartitionScope();
    resetResults();
    setText($("metadata"), () => "—");
    setText($("container-info"), () =>
      t("scope.databaseCount", () => [items.length]),
    );
    updateScopeContext();
    status(msg("ui.connectedSelectADatabaseAndContainer"));
    if (database && items.some((item) => item.id === database)) {
      $("database").value = database;
      await selectDatabase(database, { container });
    }
  }
  async function selectDatabase(next, { container = "", browse = false } = {}) {
    const full =
      browse ||
      next !== scopeState.savedDatabase ||
      (!!container && container !== scopeState.savedContainer);
    let items = [];
    if (next) {
      try {
        items = await listAll("cosmos/containers", {
          database: next,
          browse: full,
        });
      } catch (error) {
        $("database").value = scopeState.database;
        throw error;
      }
    }
    // Commit the switch only after metadata has loaded successfully.
    scopeState.database = next;
    $("database").value = next;
    setAttr($("database"), "title", () => next);
    scopeState.container = "";
    activatePartitionScope();
    resetResults();
    scopeState.containers = items;
    options("container", items, msg("scope.selectContainer"));
    setText($("metadata"), () => "—");
    setText($("container-info"), () =>
      next
        ? t("scope.containerCount", () => [items.length])
        : t("ui.selectAContainerToQuery"),
    );
    if (full && next) scopeState.containerChoices.set(next, items);
    updateScopeContext();
    status(next ? msg("ui.selectAContainer") : msg("ui.selectADatabase"));
    if (container && items.some((item) => item.id === container)) {
      $("container").value = container;
      await selectContainer(container, false);
    }
  }
  async function selectContainer(next, persist = true) {
    let scopeWarning;
    if (next && persist) {
      try {
        const result = await invoke("cosmos/selectScope", {
          database: scopeState.database,
          container: next,
        });
        scopeWarning = result?.scopeWarning;
      } catch (error) {
        $("container").value = scopeState.container;
        throw error;
      }
    }
    scopeState.container = next;
    $("container").value = next;
    setAttr($("container"), "title", () => next);
    activatePartitionScope();
    resetResults();
    void loadTablePreferences();
    const item = scopeState.containers.find((x) => x.id === next);
    setText($("metadata"), () => (item ? encodeJSON(item, null, 2) : "—"));
    setText($("container-info"), () =>
      item
        ? t("ui.partitionPath", () => [
            (item.partitionKey?.paths || []).join(", ") || t("ui.none"),
          ])
        : t("ui.selectAContainerToQuery"),
    );
    updateScopeContext();
    status(next ? msg("ui.readyToQuery") : msg("ui.selectAContainer"));
    if (next) await loadQueryInputs();
    if (scopeWarning) status(scopeWarning, true);
  }
  return { listAll, loadDatabases, selectDatabase, selectContainer };
}
