import { prepareDocument } from "../src/documents.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "acorn";
import { createI18n } from "../src/i18n-core.mjs";
import { locales, fallbackLocale } from "../src/locales/index.mjs";
import {
  t,
  message,
  LocalizedError,
  setText,
  setLocale,
  normalizeLocale,
  renderMessage,
} from "../src/i18n.mjs";
import { localizeManifest } from "../scripts/localize-manifest.mjs";
import legacyMessages from "../src/legacy-service-messages.json" with { type: "json" };

const placeholders = (value) =>
  [...new Set(value.match(/\{\d+\}/g) || [])].sort();
function walk(node, callback) {
  if (!node || typeof node !== "object") return;
  callback(node);
  for (const value of Object.values(node))
    if (Array.isArray(value)) value.forEach((v) => walk(v, callback));
    else if (value && typeof value === "object") walk(value, callback);
}

test("locale registry matches aliases and region variants, with explicit English fallback", () => {
  for (const value of ["zh", "zh-CN", "zh_TW", "ZH-Hant"])
    assert.equal(normalizeLocale(value), "zh-CN");
  for (const value of ["en", "en-US", "ja", "", null])
    assert.equal(normalizeLocale(value), "en");
});
test("a third language needs only a dictionary and registry entry; plural and missing-key fallback use the right locale", () => {
  const registry = {
    ...locales,
    fr: {
      aliases: [],
      messages: {
        "document.save": "Enregistrer",
        "results.rowCount": { one: "{0} ligne", other: "{0} lignes" },
      },
    },
  };
  const engine = createI18n(registry, fallbackLocale, "fr-CA");
  assert.equal(engine.currentLocale(), "fr");
  assert.equal(engine.t("document.save"), "Enregistrer");
  assert.equal(engine.t("results.rowCount", [0]), "0 ligne");
  assert.equal(engine.t("results.rowCount", [2]), "2 lignes");
  assert.equal(engine.t("json.foldedItems", [0]), "… 0 items");
  assert.equal(engine.t("missing.key"), "[missing.key]");
  assert.equal(engine.t("toString"), "[toString]");
  assert.throws(() => createI18n(registry, "__proto__"), /Unregistered/);
  assert.throws(
    () =>
      createI18n(
        {
          ...registry,
          other: { messages: {}, aliases: ["en"], pluralLocale: "en" },
        },
        "en",
      ),
    /Duplicate locale alias/,
  );
});
test("message recipes preserve identity without retaining rendered strings or interpreting raw data", () => {
  setLocale("zh-CN");
  const captured = message("ui.field", () => ["查询参数"]);
  const label = message("document.save");
  const error = new LocalizedError(
    message("ui.numberFieldsRequireAValidJsonNumber"),
  );
  // More messages cannot evict the recipes held by a UI node or error.
  for (let i = 0; i < 3000; i++) t("results.rowCount", () => [i]);
  setLocale("en");
  assert.equal(renderMessage(label), "Save");
  assert.equal(renderMessage("保存"), "保存");
  assert.equal(renderMessage("constructor"), "constructor");
  assert.equal(renderMessage(captured), "Field 查询参数");
  assert.equal(
    renderMessage(error),
    "Number fields require a valid JSON number without quotes",
  );
  assert.equal(
    renderMessage(
      "HTTP 412: 并发冲突：文档已变化，本次修改或删除未执行。请重新读取并核对修改。",
    ),
    "HTTP 412: Concurrency conflict. The document changed; this update or deletion was not performed. Read it again and review your changes.",
  );
  assert.equal(
    renderMessage(
      "SQL 语法错误：第 12 个字符附近。检查 WHERE、AND、括号和引号。",
    ),
    "SQL syntax error near character 12. Check WHERE, AND, brackets and quotes.",
  );
  assert.equal(
    renderMessage("Unknown Azure message: 查询参数"),
    "Unknown Azure message: 查询参数",
  );
  setLocale("zh-CN");
});
test("rebinding a detached and reattached node restores locale updates", () => {
  setLocale("zh-CN");
  const node = { isConnected: true, textContent: "" };
  setText(node, () => t("document.save"));
  node.isConnected = false;
  setLocale("en");
  node.isConnected = true;
  setText(node, () => t("document.save"));
  assert.equal(node.textContent, "Save");
  setLocale("zh-CN");
  assert.equal(node.textContent, "保存");
});
test("stable keys and placeholders are complete across all registered dictionaries", () => {
  const base = locales[fallbackLocale].messages,
    used = new Set();
  for (const name of readdirSync(new URL("../src/", import.meta.url)).filter(
    (n) => n.endsWith(".mjs") && n !== "i18n-core.mjs",
  )) {
    walk(
      parse(readFileSync(new URL("../src/" + name, import.meta.url), "utf8"), {
        ecmaVersion: "latest",
        sourceType: "module",
      }),
      (node) => {
        if (
          node.type === "CallExpression" &&
          ["t", "message", "msg"].includes(node.callee.name)
        ) {
          const collect = (expr) => {
            if (expr?.type === "Literal" && typeof expr.value === "string")
              used.add(expr.value);
            else if (expr?.type === "ConditionalExpression") {
              collect(expr.consequent);
              collect(expr.alternate);
            }
          };
          collect(node.arguments[0]);
        }
      },
    );
  }
  const html = readFileSync(
    new URL("../src/index.html", import.meta.url),
    "utf8",
  );
  for (const m of html.matchAll(
    /data-i18n-(?:text|title|aria-label|placeholder)="([^"]+)"/g,
  ))
    used.add(m[1]);
  for (const key of used)
    assert.ok(Object.hasOwn(base, key), "Missing stable key: " + key);
  for (const [locale, spec] of Object.entries(locales)) {
    assert.deepEqual(
      Object.keys(spec.messages).sort(),
      Object.keys(base).sort(),
      locale,
    );
    for (const [key, value] of Object.entries(spec.messages)) {
      assert.match(key, /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/);
      const baseVariants =
        typeof base[key] === "string" ? [base[key]] : Object.values(base[key]);
      const variants =
        typeof value === "string" ? [value] : Object.values(value);
      if (typeof value === "object")
        assert.equal(typeof value.other, "string", key);
      for (const variant of variants)
        assert.deepEqual(
          placeholders(variant),
          placeholders(baseVariants[0]),
          `${locale}:${key}`,
        );
    }
  }
});
test("manifest display strings are generated from the same registered catalogs", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url)),
  );
  assert.deepEqual(manifest, localizeManifest(manifest));
  for (const [locale, spec] of Object.entries(locales)) {
    assert.equal(
      manifest.localizations[locale].description,
      spec.messages["plugin.description"],
    );
    for (const alias of spec.aliases)
      assert.deepEqual(
        manifest.localizations[alias],
        manifest.localizations[locale],
      );
  }
  assert.equal(
    manifest.contributions[0].fields.filter((f) =>
      /language|locale/i.test(f.key),
    ).length,
    0,
  );
});
test("legacy backend explanations have explicit stable identifiers independent of dictionary copy", () => {
  const backend = new Set();
  for (const name of readdirSync(
    new URL("../backend/", import.meta.url),
  ).filter((n) => n.endsWith(".go") && !n.endsWith("_test.go")))
    for (const m of readFileSync(
      new URL("../backend/" + name, import.meta.url),
      "utf8",
    ).matchAll(/"([^"\n]*[\p{Script=Han}][^"\n]*)"/gu))
      backend.add(m[1].replace("%d", "{0}"));
  for (const text of backend)
    assert.ok(legacyMessages[text], "Missing legacy contract: " + text);
  for (const key of Object.values(legacyMessages))
    assert.ok(locales.en.messages[key]);
});

test("editing Chinese copy does not change message identity or English output", () => {
  const registry = structuredClone(locales);
  registry["zh-CN"].messages["document.save"] = "保存文档";
  const engine = createI18n(registry, "en", "zh-CN");
  const captured = engine.message("document.save");
  assert.equal(String(captured), "保存文档");
  engine.setLocale("en");
  assert.equal(String(captured), "Save");
});

test("registering a dictionary also generates its connection labels without per-language build code", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url)),
  );
  const registry = {
    ...locales,
    fr: {
      aliases: ["fr-CA"],
      messages: { "connection.name": "Nom de connexion" },
    },
  };
  const generated = localizeManifest(manifest, registry, "en");
  const fields =
    generated.localizations.fr.contributions[manifest.contributions[0].id]
      .fields;
  assert.equal(fields.display_name.label, "Nom de connexion");
  assert.equal(fields.account_key.label, "Account Key");
  assert.deepEqual(
    generated.localizations["fr-CA"],
    generated.localizations.fr,
  );
  assert.deepEqual(generated.permissions, manifest.permissions);
});

test("captured validation errors also keep translated parameter labels as recipes", () => {
  setLocale("zh-CN");
  let error;
  try {
    prepareDocument('{"id":"example"}', "{}", []);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof LocalizedError);
  setLocale("en");
  assert.equal(renderMessage(error), "Partition key must be a JSON array");
  setLocale("zh-CN");
});

test("structured backend reasons localize independently of wire text and preserve unknown errors", async () => {
  const { renderMessage, serviceMessage, setLocale } = await import(
    "../src/i18n.mjs"
  );
  const reasons = JSON.parse(
    readFileSync(
      new URL("../src/service-reasons.json", import.meta.url),
      "utf8",
    ),
  );
  for (const key of Object.values(reasons))
    assert.ok(Object.hasOwn(locales.en.messages, key), key);
  // Every plugin-owned validation site has a stable catalog entry. Changing its
  // prose does not change translation or require a text-matching decoder.
  for (const name of readdirSync(
    new URL("../backend/", import.meta.url),
  ).filter((n) => n.endsWith(".go") && !n.endsWith("_test.go"))) {
    const source = readFileSync(
      new URL("../backend/" + name, import.meta.url),
      "utf8",
    );
    for (const m of source.matchAll(
      /(?:reasonError\(|rpcReason\(-?\d+,\s*)"([^"]+)"/g,
    ))
      assert.ok(reasons[m[1]], name + ":" + m[1]);
  }
  const error = new Error(
    "This text deliberately differs from every catalog entry",
  );
  error.data = {
    reason: "cosmos.sql-syntax-position",
    args: [10],
    status: 400,
  };
  try {
    setLocale("en");
    assert.match(renderMessage(error), /^HTTP 400: SQL syntax error.*10/);
    const warning = serviceMessage(
      { reason: "warning.cacheSave" },
      "raw warning",
    );
    assert.match(String(warning), /cache/i);
    setLocale("zh-CN");
    assert.match(renderMessage(error), /^HTTP 400: SQL 语法错误：第 10/);
    assert.match(String(warning), /缓存/);
    const unknown = new Error("Original foreign error");
    unknown.data = { reason: "future.reason" };
    assert.equal(renderMessage(unknown), unknown.message);
    assert.equal(
      serviceMessage({ reason: "future.warning" }, "original warning"),
      "original warning",
    );
  } finally {
    setLocale("zh-CN");
  }
});
