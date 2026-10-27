# Changelog

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
