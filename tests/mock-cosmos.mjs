// Local test service only. It is never included in the plugin package.
import http from "node:http";
import { createHmac } from "node:crypto";
import {
  parse as parseExact,
  stringify as stringifyExact,
} from "lossless-json";
let document =
  '{"id":"order-001","tenant":"demo","status":"pending","total":9223372036854775807,"_etag":"\\\"v1\\\""}';
let version = 1,
  deleted = false,
  writeCount = 0,
  patchCount = 0,
  replaceCount = 0,
  lastPatch = null,
  denyWrites = false,
  discoveryCalls = 0,
  accountLists = 0,
  discoveryDelay = 0,
  unsupportedSeek = false,
  failNextQuery = false,
  throttleDiscovery = false;
const server = http.createServer(async (req, res) => {
  const send = (body, status = 200, headers = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "x-ms-request-charge": "2.81",
      "x-ms-activity-id": "local-test-activity",
      ...headers,
    });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  if (req.url === "/health") return send({ ok: true });
  if (req.url === "/test/state")
    return send({
      document,
      writeCount,
      patchCount,
      replaceCount,
      lastPatch,
      deleted,
      discoveryCalls,
      accountLists,
    });
  if (req.url === "/test/slow-discovery") {
    discoveryDelay = 100;
    return send({ ok: true });
  }
  if (req.url === "/test/unsupported-seek") {
    unsupportedSeek = true;
    return send({ ok: true });
  }
  if (req.url === "/test/fail-next-query") {
    failNextQuery = true;
    return send({ ok: true });
  }
  if (req.url === "/test/deny-writes") {
    denyWrites = true;
    return send({ ok: true });
  }
  if (req.url === "/test/throttle-discovery") {
    throttleDiscovery = true;
    return send({ ok: true });
  }
  if (req.url === "/test/reset") {
    document =
      '{"id":"order-001","tenant":"demo","status":"pending","total":9223372036854775807,"_etag":"\\\"v1\\\""}';
    version = 1;
    deleted = false;
    writeCount = 0;
    patchCount = 0;
    replaceCount = 0;
    lastPatch = null;
    denyWrites = false;
    discoveryCalls = 0;
    accountLists = 0;
    discoveryDelay = 0;
    unsupportedSeek = false;
    failNextQuery = false;
    throttleDiscovery = false;
    return send({ ok: true });
  }
  if (req.url === "/test/conflict") {
    version++;
    return send({ ok: true });
  }
  const decoded = decodeURIComponent(req.url.split("?")[0]);
  const kind =
    decoded.split("/").filter(Boolean).at(-1) === "dbs"
      ? "dbs"
      : decoded.endsWith("/pkranges")
        ? "pkranges"
        : decoded.includes("/docs")
          ? "docs"
          : "colls";
  const link =
    req.method === "POST" ||
    decoded.endsWith("/dbs") ||
    decoded.endsWith("/colls") ||
    decoded.endsWith("/docs") ||
    decoded.endsWith("/pkranges")
      ? decoded.slice(1).split("/").slice(0, -1).join("/")
      : decoded.slice(1);
  const payload = `${req.method.toLowerCase()}\n${kind}\n${link}\n${req.headers["x-ms-date"]?.toLowerCase()}\n\n`;
  const sig = createHmac("sha256", "test-account-key")
    .update(payload)
    .digest("base64");
  if (
    decodeURIComponent(req.headers.authorization || "") !==
    `type=master&ver=1.0&sig=${sig}`
  )
    return send({ message: "Invalid signature" }, 401);
  if (req.url === "/dbs") {
    accountLists++;
    return send({ Databases: [{ id: "Shop" }] });
  }
  if (req.url === "/dbs/Shop/colls")
    return send({
      DocumentCollections: [
        {
          id: "Orders",
          partitionKey: { paths: ["/tenant"], kind: "Hash", version: 2 },
          indexingPolicy: { automatic: true },
        },
        {
          id: "Archive",
          partitionKey: { paths: ["/tenant"], kind: "Hash", version: 2 },
        },
      ],
    });
  if (
    req.method === "GET" &&
    /^\/dbs\/Shop\/colls\/(Orders|Archive)$/.test(req.url)
  )
    return send({
      id: req.url.split("/").at(-1),
      partitionKey: { paths: ["/tenant"], kind: "Hash", version: 2 },
    });
  if (req.url.endsWith("/pkranges"))
    return send({ PartitionKeyRanges: [{ id: "0" }, { id: "1" }] });
  if (req.method === "GET" && req.url.endsWith("/docs")) {
    discoveryCalls++;
    if (throttleDiscovery) {
      throttleDiscovery = false;
      return send({}, 429, { "x-ms-retry-after-ms": "50" });
    }
    if (req.url.includes("/Archive/"))
      return send({ Documents: [{ tenant: "archive-only" }] });
    if (req.headers["x-ms-continuation"])
      return send({ Documents: [{ tenant: "beta" }] });
    return send(
      '{"Documents":[{"tenant":"demo"},{"tenant":"demo"},{"tenant":42},{"tenant":"42"},{"tenant":null},{"tenant":9223372036854775807},{}]}',
      200,
      { "x-ms-continuation": "sample-next" },
    );
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  if (
    denyWrites &&
    (req.method === "PATCH" ||
      req.method === "PUT" ||
      req.method === "DELETE" ||
      (req.method === "POST" &&
        req.headers["x-ms-documentdb-isquery"] !== "true"))
  )
    return send(
      { message: "The account key is read only; secret-upstream-value" },
      403,
    );
  if (
    /^\/dbs\/Shop\/colls\/(Orders|Archive)\/docs$/.test(req.url) &&
    req.headers["x-ms-documentdb-isquery"] === "true"
  ) {
    const query = JSON.parse(body).query;
    if (
      query.startsWith("SELECT TOP 1 ") &&
      query !== "SELECT TOP 1 c.id FROM c"
    ) {
      discoveryCalls++;
      if (discoveryDelay)
        await new Promise((resolve) => setTimeout(resolve, discoveryDelay));
      if (unsupportedSeek) return send({}, 400);
      if (throttleDiscovery) {
        throttleDiscovery = false;
        return send({}, 429, { "x-ms-retry-after-ms": "50" });
      }
      const archive = req.url.includes("/Archive/"),
        second = req.headers["x-ms-documentdb-partitionkeyrangeid"] === "1";
      const after = JSON.parse(body).parameters?.[0]?.value;
      let raw;
      if (query.includes("IS_STRING")) {
        let values = archive
          ? ["archive-only"]
          : second
            ? ["demo", "omega"]
            : ["42", "alpha", "beta", "demo"];
        if (!archive && !second && !deleted) {
          const tenant = JSON.parse(document).tenant;
          if (typeof tenant === "string")
            values = [...new Set([...values, tenant])].sort();
        }
        const next = values.find(
          (value) => after === undefined || value > after,
        );
        if (next !== undefined) raw = JSON.stringify(next);
      } else if (!archive && !second && query.includes("IS_NUMBER")) {
        if (after === undefined) raw = "42";
        else if (after === 42) raw = "9223372036854775807";
      } else if (!archive && !second && query.includes(" = false"))
        raw = "false";
      else if (!archive && !second && query.includes(" = true")) raw = "true";
      else if (!archive && !second && query.includes("IS_NULL")) raw = "null";
      else if (!archive && !second && query.includes("AS found"))
        return send({ Documents: [{ found: 1 }] });
      return send(
        raw === undefined
          ? '{"Documents":[]}'
          : `{"Documents":[{"k0":${raw}}]}`,
      );
    }
    if (
      query.startsWith("SELECT DISTINCT ") ||
      query.startsWith("SELECT TOP 1 1 AS found")
    ) {
      discoveryCalls++;
      if (discoveryDelay)
        await new Promise((resolve) => setTimeout(resolve, discoveryDelay));
      if (throttleDiscovery) {
        throttleDiscovery = false;
        return send({}, 429, { "x-ms-retry-after-ms": "50" });
      }
      if (query.startsWith("SELECT TOP 1 1 AS found"))
        return send({
          Documents: req.url.includes("/Archive/") ? [] : [{ found: 1 }],
        });
      if (req.url.includes("/Archive/"))
        return send({ Documents: [{ k0: "archive-only" }] });
      if (req.headers["x-ms-documentdb-partitionkeyrangeid"] === "1")
        return send({ Documents: [{ k0: "omega" }] });
      if (req.headers["x-ms-continuation"])
        return send({ Documents: [{ k0: "beta" }] });
      return send(
        '{"Documents":[{"k0":"alpha"},{"k0":"demo"},{"k0":42},{"k0":"42"},{"k0":null},{"k0":9223372036854775807}]}',
        200,
        {
          "x-ms-continuation": "distinct-next",
        },
      );
    }
    if (query === "SELECT TOP 1 c.id FROM c")
      return send({
        Documents: deleted ? [] : [{ id: JSON.parse(document).id }],
      });
    if (failNextQuery) {
      failNextQuery = false;
      return send({}, 503);
    }
    if (req.headers["x-ms-continuation"]) return send('{"Documents":[]}', 200);
    if (query.includes("BAD") || /FROM\s+c\s+AND/i.test(query))
      return send(
        {
          code: "BadRequest",
          message: JSON.stringify({
            errors: [
              {
                code: "SC1001",
                location: { start: 14, end: 17 },
                message: "Syntax error near secret-upstream-value",
              },
            ],
          }),
        },
        400,
      );
    if (query.includes("NEEDS_PIPELINE"))
      return send(
        {
          message:
            "Cross partition query can not be directly served by the gateway",
        },
        400,
      );
    return send(`{"Documents":[${deleted ? "" : document}]}`, 200, {
      "x-ms-continuation": "second-page",
    });
  }
  if (req.method === "GET" && req.url.includes("/docs/"))
    return deleted
      ? send({}, 404)
      : send(document, 200, { ETag: `"v${version}"` });
  if (req.method === "PATCH") {
    const spec = parseExact(body);
    if (
      req.headers["if-match"] !== `"v${version}"` ||
      spec.condition !==
        "from c where c._etag = " + JSON.stringify(`"v${version}"`)
    )
      return send({}, 412);
    if (spec.operations.length < 1 || spec.operations.length > 10)
      return send({ message: "Patch operation limit" }, 400);
    const next = parseExact(document);
    for (const op of spec.operations) {
      const parts = op.path
        .slice(1)
        .split("/")
        .map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"));
      let parent = next;
      for (const part of parts.slice(0, -1)) parent = parent[part];
      if (!parent) return send({ message: "Patch parent path missing" }, 400);
      if (op.op === "remove") delete parent[parts.at(-1)];
      else
        Object.defineProperty(parent, parts.at(-1), {
          value: op.value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    version++;
    writeCount++;
    patchCount++;
    lastPatch = JSON.parse(body);
    next._etag = `"v${version}"`;
    document = stringifyExact(next);
    return send(document, 200, { ETag: `"v${version}"` });
  }
  if (req.method === "PUT" || req.method === "DELETE") {
    if (req.headers["if-match"] !== `"v${version}"`) return send({}, 412);
    writeCount++;
    version++;
    if (req.method === "DELETE") {
      deleted = true;
      return send("", 204);
    }
    replaceCount++;
    document = body.replace(/}$/, `,"_etag":"\\\"v${version}\\\""}`);
    return send(document, 200, { ETag: `"v${version}"` });
  }
  if (req.method === "POST") {
    writeCount++;
    document = body.replace(/}$/, `,"_etag":"\\\"v${++version}\\\""}`);
    deleted = false;
    return send(document, 201, { ETag: `"v${version}"` });
  }
  send({}, 404);
});
server.listen(18081, "127.0.0.1", () =>
  console.log("Mock Cosmos: http://127.0.0.1:18081"),
);
