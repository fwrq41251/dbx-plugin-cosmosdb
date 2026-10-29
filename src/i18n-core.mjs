const messageBrand = Symbol("localized-message");
const canonical = (value) =>
  String(value || "")
    .replaceAll("_", "-")
    .toLowerCase();

// Pure formatter: no DOM, host, storage or process-wide rendered-string cache.
export function createI18n(registry, fallback, initialLocale = fallback) {
  if (!Object.hasOwn(registry, fallback))
    throw new Error(`Unregistered fallback locale: ${fallback}`);
  const aliases = new Map(),
    plurals = new Map(),
    listeners = new Set();
  for (const [locale, spec] of Object.entries(registry)) {
    for (const alias of [locale, ...(spec.aliases || [])]) {
      const key = canonical(alias);
      if (aliases.has(key) && aliases.get(key) !== locale)
        throw new Error(`Duplicate locale alias: ${alias}`);
      aliases.set(key, locale);
    }
    plurals.set(locale, new Intl.PluralRules(spec.pluralLocale || locale));
  }
  const normalizeLocale = (value) => {
    const parts = canonical(value).split("-");
    while (parts.length) {
      const match = aliases.get(parts.join("-"));
      if (match) return match;
      parts.pop();
    }
    return fallback;
  };
  let locale = normalizeLocale(initialLocale);
  function t(key, values = () => []) {
    const args = typeof values === "function" ? values() : values;
    const source = Object.hasOwn(registry[locale].messages, key)
      ? locale
      : fallback;
    let pattern = Object.hasOwn(registry[source].messages, key)
      ? registry[source].messages[key]
      : undefined;
    if (pattern === undefined) return `[${key}]`;
    if (typeof pattern === "object")
      pattern =
        pattern[plurals.get(source).select(Number(args[0]))] ?? pattern.other;
    return pattern.replace(/\{(\d+)\}/g, (_, index) =>
      String(args[index] ?? ""),
    );
  }
  function message(key, values = () => []) {
    return Object.freeze({
      [messageBrand]: true,
      key,
      values,
      toString: () => t(key, values),
    });
  }
  function renderMessage(value) {
    if (value?.[messageBrand]) return String(value);
    if (value?.localizedMessage?.[messageBrand])
      return String(value.localizedMessage);
    return String(value instanceof Error ? value.message : (value ?? ""));
  }
  return {
    t,
    message,
    renderMessage,
    normalizeLocale,
    currentLocale: () => locale,
    setLocale(value) {
      const next = normalizeLocale(value);
      if (next === locale) return false;
      locale = next;
      for (const listener of listeners) listener(next);
      return true;
    },
    onLocaleChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
