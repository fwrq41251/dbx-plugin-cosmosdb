export function defaultQueryInput() {
  return {
    sql: "SELECT * FROM c",
    partitionKeyText: "",
    parametersText: "[]",
    pageSize: 100,
  };
}

// The target is captured before asynchronous work. A late read or write from
// another scope must never replace current input or borrow its connection.
export function createQueryInputs({ invoke, read, apply, failed }) {
  const entries = new Map();
  let current = null,
    generation = 0,
    applying = false;
  const keyFor = (target) =>
    JSON.stringify([target.connectionId, target.database, target.container]);
  function display(value) {
    applying = true;
    try {
      apply({ ...value });
    } finally {
      applying = false;
    }
  }
  function prune() {
    for (const [key, entry] of entries) {
      if (entries.size <= 30) break;
      if (entry !== current && entry.loaded && !entry.pending)
        entries.delete(key);
    }
  }
  async function activate(target) {
    const generationAtStart = ++generation,
      key = keyFor(target);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        target: { ...target },
        value: defaultQueryInput(),
        revision: 0,
        loaded: false,
        pending: 0,
        writes: Promise.resolve(),
      };
      entries.set(key, entry);
    }
    current = entry;
    display(entry.value);
    const revision = entry.revision;
    if (!entry.loading && !entry.loaded) {
      entry.loading = (async () => {
        try {
          await entry.writes;
          const value = await invoke("cosmos/queryInput", entry.target);
          if (entry.revision === revision) entry.value = value;
        } catch (error) {
          if (current === entry) failed("load", error);
        } finally {
          entry.loaded = true;
        }
      })();
    }
    await entry.loading;
    if (
      current === entry &&
      generation === generationAtStart &&
      entry.revision === revision
    )
      display(entry.value);
    prune();
  }
  function changed() {
    if (applying || !current) return;
    const entry = current,
      value = read();
    if (JSON.stringify(value) === JSON.stringify(entry.value)) return;
    entry.value = { ...value };
    const revision = ++entry.revision;
    ++entry.pending;
    entry.writes = entry.writes
      .catch(() => {})
      .then(async () => {
        // Coalesce edits queued behind an in-flight save. The newest snapshot is
        // still written immediately, without relying on an unload timer.
        if (entry.revision !== revision) return;
        try {
          await invoke("cosmos/queryInput", {
            ...entry.target,
            queryInput: value,
          });
        } catch (error) {
          if (current === entry && entry.revision === revision)
            failed("save", error);
        }
      })
      .finally(() => {
        --entry.pending;
        prune();
      });
  }
  function deactivate(clear = false) {
    ++generation;
    current = null;
    if (clear) entries.clear();
    display(defaultQueryInput());
  }
  function reset() {
    display(defaultQueryInput());
    changed();
  }
  return { activate, changed, deactivate, reset };
}
