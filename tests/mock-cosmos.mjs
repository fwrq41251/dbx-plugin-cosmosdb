// Local test service only. It is never included in the plugin package.
import http from "node:http";
import { createHmac } from "node:crypto";
let document =
  '{"id":"order-001","tenant":"demo","status":"pending","total":9223372036854775807,"_etag":"\\\"v1\\\""}';
let version = 1,
  deleted = false,
  writeCount = 0;
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
  if (req.url === "/test/state") return send({ document, writeCount, deleted });
  if (req.url === "/test/reset") {
    document =
      '{"id":"order-001","tenant":"demo","status":"pending","total":9223372036854775807,"_etag":"\\\"v1\\\""}';
    version = 1;
    deleted = false;
    writeCount = 0;
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
      : decoded.includes("/docs")
        ? "docs"
        : "colls";
  const link =
    req.method === "POST" ||
    decoded.endsWith("/dbs") ||
    decoded.endsWith("/colls")
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
  if (req.url === "/dbs") return send({ Databases: [{ id: "Shop" }] });
  if (req.url === "/dbs/Shop/colls")
    return send({
      DocumentCollections: [
        {
          id: "Orders",
          partitionKey: { paths: ["/tenant"], kind: "Hash", version: 2 },
          indexingPolicy: { automatic: true },
        },
      ],
    });
  let body = "";
  for await (const chunk of req) body += chunk;
  if (
    req.url === "/dbs/Shop/colls/Orders/docs" &&
    req.headers["x-ms-documentdb-isquery"] === "true"
  ) {
    if (req.headers["x-ms-continuation"]) return send('{"Documents":[]}', 200);
    const query = JSON.parse(body).query;
    if (query.includes("BAD")) return send({ message: "Invalid SQL" }, 400);
    return send(`{"Documents":[${deleted ? "" : document}]}`, 200, {
      "x-ms-continuation": "second-page",
    });
  }
  if (req.method === "GET" && req.url.includes("/docs/"))
    return deleted
      ? send({}, 404)
      : send(document, 200, { ETag: `"v${version}"` });
  if (req.method === "PUT" || req.method === "DELETE") {
    if (req.headers["if-match"] !== `"v${version}"`) return send({}, 412);
    writeCount++;
    version++;
    if (req.method === "DELETE") {
      deleted = true;
      return send("", 204);
    }
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
