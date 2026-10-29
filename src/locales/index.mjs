import en from "./en.json" with { type: "json" };
import zhCN from "./zh-CN.json" with { type: "json" };

export const fallbackLocale = "en";
// Register additional dictionaries here. Region variants fall back to their
// registered language alias; unsupported languages use fallbackLocale.
export const locales = {
  en: { messages: en, aliases: [], pluralLocale: "en" },
  "zh-CN": { messages: zhCN, aliases: ["zh"], pluralLocale: "zh-CN" },
};
