# Changelog

## 0.11.0 — Selected SQL execution and inline syntax locations

- Run the selected SQL verbatim from the existing button or query shortcut; reject blank/multiple selections without falling back to the full editor.
- Capture execution source/line ranges; pagination and post-write refresh retain the submitted SQL snapshot.
- Map trustworthy service syntax offsets into the editor, underline/scroll to them and offer click-to-focus; clear stale diagnostics on edits and scope changes.
- Handle the query shortcut before CodeMirror can insert a blank line and collapse the intended selection; ignore key repeats and preserve JSON-editor shortcut scope.

## 0.10.2 — Simplify result columns

- Remove column selection, field search and pin toggles; display every returned field and keep id fixed on the left.
- Keep per-container column widths, cell selection/copy and local result filtering.
- Migrate legacy layouts by discarding hidden/pin settings while retaining saved widths.

## 0.10.1 — Workbench interaction refinements

- Compact result controls, persistent RU/time and result provenance; collapsible SQL and document panels.
- Explicit cell selection with keyboard navigation/copy, independent of document drafts; double-click/Enter previews and per-row Open Document reads.
- Consistent current-page filtering across table, JSON and export; clear action, accurate empty states and reset after a successful new query.
- Searchable column popover with show-all, counts, stable checkbox focus and Escape/outside dismissal; table-only controls hidden in JSON mode.

## 0.10.0 — Result tools, query cancellation and metadata caching

- Remove the 20-column display limit; add column selection, remembered widths, pinned id, current-page filtering, exact cell copy and projected row JSON copy.
- Persist only table layout metadata in private per-connection/container local files; add no host permissions.
- Point-read a complete result row directly using its own id and full partition key, preserving the unsaved-draft confirmation.
- Show query elapsed time and unknown RU while running; cancel through the sidecar HTTP context, retain previous results, and reject late responses after cancel/requery.
- Cache MCP container definitions for five minutes with isolated keys, explicit refresh, source/timestamps and invalidation after container-related 400/404 responses. Cached validation adds no metadata RU.
- Fix primary-button hover text contrast.

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
