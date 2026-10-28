# Changelog

## 0.9.0 — Read-only MCP bridge

- Expose container metadata, explicit-partition SQL queries, point reads and local cached partition-key lookup through DBX's `mcp/tools` / `mcp/call` bridge.
- Bind every tool to a host-managed container connection. No endpoint, credential, database/container override or mutation arguments are accepted.
- Keep MCP read-only even when the saved UI connection permits writes; leave the built-in AI surface disabled.
- Default to 20 rows, cap pages at 100, require explicit continuation and preserve numbers through JSON text fields. Cursors expire after 10 minutes and are bound to the full query context.
- Reject oversized output instead of silently truncating or skipping documents. Return current-page RU, timing and Activity ID.
- Require DBX 0.6.58+. The validated stable pairing is DBX 0.6.58 with MCP Server 0.4.132; MCP 0.4.134's new per-tool grant model requires a newer desktop/manifest contract and is not supported by this candidate.

## 0.8.0 — First marketplace candidate

- Establish the permanent plugin ID `io.github.fwrq41251.cosmosdb` and publisher `fwrq41251`.
- Publish macOS ARM64 candidates from tagged source through the pinned official DBX release workflow.
- Query Cosmos DB for NoSQL with SQL parameters, explicit logical partition keys and cached pagination.
- Discover partition candidates through index seeking with filtering, resumable progress, a local cache and a per-run RU budget.
- Save a connection scoped to a database and container.
- View query results as a table or JSON, export the current page, and point-read complete documents.
- Edit documents through typed fields or CodeMirror JSON with exact numeric literals, search, formatting, error positions and nested folding.
- Offer basic Cosmos SQL keyword, function, parameter and already-read field completion without extra schema scans.
- Support user-confirmed single-document create, ETag-conditional Patch/replace and delete; enforce read-only connections in the backend.
- Align controls and simplify document tools; preserve the selected document view and avoid query shortcuts interrupting JSON drafts.

This is a community plugin, not a Microsoft product. Account Key authentication only. The first listing supports macOS ARM64. Full SDK cross-partition query pipelines, Entra ID, bulk mutations, query history/favorites and query cancellation are not included.

Development versions up to 0.7.1 used `io.local.cosmosdb` and were distributed as local unsigned packages. See `docs/RELEASING.md` for the identity transition.
