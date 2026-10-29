import { createI18n } from "./i18n-core.mjs";
import { locales, fallbackLocale } from "./locales/index.mjs";
import legacyServiceMessages from "./legacy-service-messages.json" with { type: "json" };

import serviceReasons from "./service-reasons.json" with { type: "json" };

const i18n = createI18n(
  locales,
  fallbackLocale,
  globalThis.window?.dbxPlugin?.locale ||
    (typeof window === "undefined" ? "zh-CN" : fallbackLocale),
);
export const { t, message, normalizeLocale, currentLocale, onLocaleChange } =
  i18n;

// Keep an explicit recipe across async work or a locale change. Never infer a
// message identity by comparing user-visible strings or retaining their values.
export class LocalizedError extends Error {
  constructor(key, values = () => []) {
    super();
    this.name = "LocalizedError";
    this.localizedMessage =
      typeof key === "string" ? message(key, values) : key;
    Object.defineProperty(this, "message", {
      configurable: true,
      get: () => String(this.localizedMessage),
    });
  }
}
export function serviceMessage(detail, fallback = "") {
  const key =
    detail && Object.hasOwn(serviceReasons, detail.reason)
      ? serviceReasons[detail.reason]
      : undefined;
  return key
    ? message(key, () => (Array.isArray(detail.args) ? detail.args : []))
    : fallback;
}
export function renderMessage(value) {
  if (value instanceof Error && value.data?.reason) {
    const translated = serviceMessage(value.data);
    if (translated)
      return (
        (Number.isInteger(value.data.status)
          ? `HTTP ${value.data.status}: `
          : "") + String(translated)
      );
  }
  if (typeof value !== "string") {
    const rendered = i18n.renderMessage(value);
    return value instanceof Error && !value.localizedMessage
      ? renderMessage(rendered)
      : rendered;
  }
  // Compatibility with existing backend wire messages. This allowlist is
  // independent of both dictionaries; changing UI copy cannot break decoding.
  const key = Object.hasOwn(legacyServiceMessages, value)
    ? legacyServiceMessages[value]
    : undefined;
  if (key) return t(key);
  const http = /^(HTTP \d+: )(.*)$/s.exec(value);
  if (http) return http[1] + renderMessage(http[2]);
  const syntax =
    /^SQL 语法错误：第 (\d+) 个字符附近。检查 WHERE、AND、括号和引号。$/.exec(
      value,
    );
  if (syntax) return t("errors.sqlSyntaxCharacter", () => [syntax[1]]);
  return value;
}
const bindings = new WeakMap(),
  nodes = new Set();
function bind(node, key, render) {
  let entry = bindings.get(node);
  if (!entry) {
    entry = { renders: new Map(), ref: new WeakRef(node) };
    bindings.set(node, entry);
  }
  // A detached menu/widget may later be reattached and rebound.
  nodes.add(entry.ref);
  entry.renders.set(key, render);
  render();
}
export function setText(node, value) {
  bind(node, "textContent", () => {
    const text = String(value() ?? "");
    if (node.textContent !== text) node.textContent = text;
  });
}
export function setAttr(node, key, value) {
  bind(node, key, () => {
    const text = String(value() ?? "");
    if (node.getAttribute(key) !== text) node.setAttribute(key, text);
  });
}
// Subscribe before editors so their own reconfiguration runs after UI bindings.
i18n.onLocaleChange(() => {
  for (const ref of nodes) {
    const node = ref.deref();
    if (!node || !node.isConnected) {
      nodes.delete(ref);
      continue;
    }
    for (const render of bindings.get(node)?.renders.values() || []) render();
  }
});
export function setLocale(value) {
  const next = normalizeLocale(value);
  if (typeof document !== "undefined") document.documentElement.lang = next;
  i18n.setLocale(next);
}
// Only explicitly marked UI nodes are localized. Data and source code are never
// scanned for natural-language wording, even during initial construction.
export function localizeStaticDOM(root) {
  for (const node of root.querySelectorAll("[data-i18n-text]")) {
    const text = [...node.childNodes].find(
      (child) => child.nodeType === 3 && child.textContent.trim(),
    );
    if (!text)
      throw new Error(
        `Missing localization text node: ${node.dataset.i18nText}`,
      );
    const leading = /^\s*/.exec(text.textContent)[0],
      trailing = /\s*$/.exec(text.textContent)[0];
    setText(text, () => leading + t(node.dataset.i18nText) + trailing);
  }
  for (const node of root.querySelectorAll(
    "[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder]",
  ))
    for (const attr of ["title", "aria-label", "placeholder"]) {
      const key = node.getAttribute("data-i18n-" + attr);
      if (key) setAttr(node, attr, () => t(key));
    }
  document.documentElement.lang = currentLocale();
}
