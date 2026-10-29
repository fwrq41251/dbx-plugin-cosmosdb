import { locales, fallbackLocale } from "../src/locales/index.mjs";
const providerId = "io.github.fwrq41251.cosmosdb.connection";
const fields = {
  display_name: "connection.name",
  host: "connection.endpoint",
  account_key: "connection.key",
  read_only: "connection.readOnlyOption",
};

// The structural manifest remains the source for permissions, IDs and schema.
// Only display strings and their locale overrides are generated from catalogs.
export function localizeManifest(
  source,
  registry = locales,
  fallback = fallbackLocale,
) {
  const manifest = structuredClone(source),
    base = registry[fallback].messages;
  const provider = manifest.contributions.find(
    (item) => item.id === providerId,
  );
  if (!provider) throw new Error(`Missing connection provider: ${providerId}`);
  manifest.description = base["plugin.description"];
  for (const field of provider.fields)
    if (fields[field.key]) field.label = base[fields[field.key]];
  manifest.localizations = {};
  for (const [locale, spec] of Object.entries(registry)) {
    const translated = (key) => spec.messages[key] ?? base[key];
    const localization = {
      description: translated("plugin.description"),
      contributions: {
        [providerId]: {
          fields: Object.fromEntries(
            Object.entries(fields).map(([field, key]) => [
              field,
              { label: translated(key) },
            ]),
          ),
        },
      },
    };
    for (const alias of [locale, ...(spec.aliases || [])])
      manifest.localizations[alias] = structuredClone(localization);
  }
  return manifest;
}
