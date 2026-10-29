import { t, message as msg, LocalizedError } from "./i18n.mjs";
import { parseJSON, encodeJSON } from "./model.mjs";
import { isLosslessNumber } from "lossless-json";

export function partitionLabel(text) {
  const values = parseJSON(text);
  return values
    .map((value) =>
      typeof value === "string"
        ? value
        : value !== null &&
            typeof value === "object" &&
            Object.keys(value).length === 0
          ? t("partition.undefined")
          : encodeJSON(value),
    )
    .join(" / ");
}
export class PartitionCandidates {
  constructor() {
    this.keys = new Map();
    this.stats = {
      sample: this.empty(),
      distinct: this.empty(),
      seek: this.empty(),
    };
  }
  empty() {
    return { started: false, continuation: "", pages: 0, scanned: 0, ru: 0 };
  }
  add(text) {
    const value = parseJSON(text);
    if (!Array.isArray(value) || value.length < 1 || value.length > 3)
      throw new LocalizedError(msg("ui.partitionKeyRequiresComponents"));
    if (
      value.some(
        (v) =>
          v !== null &&
          typeof v !== "string" &&
          typeof v !== "boolean" &&
          typeof v !== "number" &&
          !isLosslessNumber(v) &&
          !(
            typeof v === "object" &&
            !Array.isArray(v) &&
            Object.keys(v).length === 0
          ),
      )
    )
      throw new LocalizedError(msg("ui.partitionKeyComponentsMustBeScalarsOr"));
    const key = encodeJSON(value);
    this.keys.set(key, {
      key,
      get label() {
        return partitionLabel(key);
      },
    });
  }
  merge(page) {
    for (const key of page.keys) this.add(key);
    const s = this.stats[page.mode];
    s.started = true;
    s.continuation = page.continuation;
    s.pages++;
    s.scanned += page.scanned;
    s.ru += page.ru;
  }
  filter(text) {
    const needle = text.trim().toLocaleLowerCase();
    return [...this.keys.values()]
      .filter((item) =>
        (item.key + " " + item.label).toLocaleLowerCase().includes(needle),
      )
      .sort((a, b) => a.label.localeCompare(b.label));
  }
}

// One page at a time, independent of the workbench's foreground actions.
export class PartitionLoader {
  constructor(
    cache,
    mode,
    fetchPage,
    changed = () => {},
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    Object.assign(this, { cache, mode, fetchPage, changed, wait });
    this.running = false;
    this.error = "";
    this.notice = "";
    this.task = null;
    this.seen = new Set();
  }
  start() {
    this.running = true;
    if (this.task) return this.task;
    this.error = "";
    this.task = this.run().finally(() => {
      this.task = null;
      this.running = false;
      this.changed();
    });
    this.changed();
    return this.task;
  }
  stop() {
    this.running = false;
    this.changed();
  }
  async run() {
    let retries = 0;
    let runRU = 0;
    while (this.running) {
      const stats = this.cache.stats[this.mode];
      if (stats.started && !stats.continuation) break;
      try {
        const page = await this.fetchPage(this.mode, stats.continuation);
        if (page.continuation && this.seen.has(page.continuation))
          throw new LocalizedError(
            msg("ui.theServiceReturnedARepeatedContinuationToken2"),
          );
        if (page.continuation) this.seen.add(page.continuation);
        this.cache.merge(page);
        runRU += page.ru;
        retries = 0;
        this.notice = page.cacheWarning || "";
        if (runRU >= 2000 && page.continuation) {
          this.notice = msg("ui.theRuAutomaticLoadingBudgetIsReached");
          this.running = false;
        }
        this.changed();
      } catch (error) {
        if (error?.message === "STALE") break;
        const code =
          error?.data?.status || Number(/HTTP (\d+)/.exec(error.message)?.[1]);
        if (code === 429 && retries++ < 4) {
          this.notice = msg("ui.rateLimitedWaitingBeforeResuming");
          this.changed();
          const delay = Math.min(
            10000,
            Math.max(250, Number(error?.data?.retryAfterMs) || 1000),
          );
          await this.wait(delay);
          continue;
        }
        this.error = error;
        break;
      }
    }
  }
}
