# Changelog

## 0.26.0 — Windows x64 build support

- Add native Windows x64 CI and release builds alongside the existing macOS ARM64 release target; no Windows ARM64 package yet. Windows native DBX/WebView2 device testing is deferred.
- Fix UI build paths containing drive letters, spaces or non-ASCII characters, and declare Edge/WebView2 alongside Safari as a compilation target. Keep browser screenshots inside each isolated test run.
- Make packaged-sidecar verification portable to Windows pipes; check native target/executable suffix, protocol, exact input persistence and independent workspaces using a disposable local service and data directory.
- Retain Unix private-mode assertions while running persistence tests on Windows without treating synthetic Unix permission bits as ACL verification.

## 0.25.0 — Independent native query workspaces

- Isolate SQL, partition keys, parameters, page size and selected location by the host workbench id, in addition to connection/endpoint/container. Restore each native tab without executing a query.
- Recognize the native New Query context: inherit the source workbench location, start with default query input, and never overwrite the ordinary connection-reopen fallback. Migrate existing input on first ordinary-workbench use.
- Keep the connection default and MCP scope independent of restored tabs. Explicit container selections still update the shared default; failures to save a tab-specific location produce a localized warning.
- On supported hosts, flush pending input saves and stop only this workbench’s query/discovery on close. No additional plugin-level tab bar or new-query button.
- Requires a DBX host update to make its native New Query button force a new plugin workbench. Older hosts retain their previous behavior.

## 0.24.0 — Restore container query input

- Automatically save SQL, partition text, parameter text and page size in private local storage, isolated by connection, endpoint, database and container. Restore input on reopening or returning to a container without executing queries or discovery.
- Preserve unfinished syntax and exact numeric text; coalesce local saves and reject late restores after edits or scope changes. Keep current input usable on storage failure.
- Add Reset query in a compact query-actions menu. Reset input defaults without discarding results or a document draft.
- Rebuild CodeMirror language extensions using the current host locale when loading another document or restoring SQL; avoid redundant SQL editor reconstruction when its text is unchanged.

## 0.23.0 — Session boundaries and stable error contracts

- Separate query execution/cancellation, document writes/identity and scope transitions into controllers with independent state; retain draft, stale-response and write-confirmation safeguards.
- Add stable reason/args to RPC and MCP failures and structured warning details while retaining legacy messages, codes and metadata. Translate by reason, with raw fallback for unknown errors.
- Isolate each browser run’s host/plugin/SDK storage and ports, clean up after servers exit, and retain debugging artifacts separately. Write generated UI atomically.

## 0.22.0 — Stable localization identities

- Introduce stable message IDs, complete Chinese/English dictionaries and a locale registry. Generate manifest translations from the same catalogs; adding a language no longer requires changing the formatter, HTML or connection-form mappings.
- Replace rendered-text reverse lookup with explicit message recipes and localized errors. Mark static UI nodes explicitly; preserve raw SQL, identifiers and document values. Repair detached-node rebinding and locale-sensitive cached partition labels.
- Separate document change kinds from presentation labels, freeze completed-query durations, and make JSON formatting linear in input/output traversal without changing numeric tokens or output.

## 0.21.0 — Follow the DBX language

- Add Chinese and English UI messages, automatically following the DBX host locale and live environment changes. Other locales fall back to English; no plugin language preference or switch is added.
- Translate connection form labels through manifest localizations, workbench actions, confirmations, accessibility labels, CodeMirror search/diagnostics and counted JSON folds. Preserve SQL, identifiers, document values, drafts, undo history and result state when the language changes.
- Keep backend/MCP error contracts unchanged; localize recognized plugin explanations only at UI boundaries and preserve unknown service messages.

## 0.20.0 — Clearer JSON structure

- Add subtle JSON hierarchy guides and accent the current container in document and result readers. Fold summaries count direct object properties or array items without parsing numeric values into JavaScript numbers.
- Enlarge gutter chevrons and support keyboard expansion of folded summaries. Preserve full-source copy, result-item context menus and existing fold shortcuts.
- Hide query parameters for ordinary SQL; reveal and expand them when SQL uses a real parameter placeholder or parameter input is populated. Ignore placeholders inside quoted strings and comments.

## 0.19.0 — Persistent view choices and quieter tools

- Persist independent result table/JSON and document fields/JSON choices as private plugin-wide enum preferences, reused on reload, reconnect, container changes, new documents and previews. Merge partial updates atomically; invalid records fall back and storage failures leave the current view usable.
- Merge cell/row copy into one icon menu with context-menu and keyboard access. Hide result filtering/copy/pagination before the first query; keep query metrics in the result heading without duplicate success notifications.
- Move full replacement and UUID regeneration into a document action menu. Full replacement remains explicitly confirmed and applies to one save only; subsequent normal saves use Patch.
- Standardize auxiliary icons, retain text for main actions and view/page choices, and remove the duplicate panel toggle while a document is visible.

## 0.18.0 — Inline partition entry and compact document actions

- Merge partition typing, candidate filtering and selection into an editable combobox with an embedded arrow. Typing reads/filters local candidates only; explicit dropdown or ArrowDown starts automatic cached/resumable discovery. Preserve typed JSON precision and keyboard access.
- Remove the separate partition search field and simplify dropdown controls, keeping progress, RU, pause/resume and refresh. Position options above or below the input to fit the viewport.
- Replace row document/preview text actions and the document-panel toggle with accessible icons; narrow the row action column while retaining manual point reads and hidden drafts.
- Clarify that result search filters the loaded page only, without querying the database.

## 0.17.0 — Focused query workspace

- Remove SQL collapse, alternate run and search controls; keep selected SQL execution, completion and undo in a lean SQL editor. JSON search remains available.
- Hide the document panel until explicitly opened, previewed, read or created. Close it without losing drafts, restore the result view from expanded mode, and hide an empty panel after successful queries or scope changes.
- Move new-document access to the result toolbar and add a close action inside the document panel.
- Show SQL syntax errors once below the editor, with a location action only for trustworthy offsets; clear obsolete hints on edits and retain separate execution errors for non-syntax failures.
- Simplify learned-field completion to icons and field names without repeated explanatory text.

## 0.16.0 — Persistent plugin-managed location and current MCP compatibility

- Remove database/container fields from the connection form; atomically persist validated selections in private plugin storage, isolated by connection and endpoint. Migrate existing defaults without rewriting credentials.
- Reopening the workbench and MCP use the last selected location. Failed saves retain the current container and draft; corrupt/unavailable locations fail explicitly. Switching away and back invalidates old MCP cursors.
- Require DBX 0.6.59+ and declare per-tool read access for the four MCP tools. Verified with MCP Server 0.4.134 and the desktop capability grant UI; MCP remains read-only independently of UI write permissions.

## 0.15.0 — Searchable database and container breadcrumbs

- Make database/container breadcrumbs searchable selectors with lazy paginated lists, local caching, explicit refresh and keyboard navigation.
- **Behavior change:** saved database/container settings are the default UI location, rather than a UI access boundary. Initial opening still validates/loads the default directly; MCP remains bound to the saved scope.
- Preserve draft-discard confirmation, readonly settings and credential handling; send UI reads/writes to the explicitly selected scope without changing saved defaults.
- Clear stale results/document identity and isolate partition candidates, completions and table preferences; failed database metadata loads retain the current scope and draft.
- Ignore dismissed late list responses; keep temporary scope during metadata refresh and restore saved defaults on reconnect.

## 0.14.0 — Workbench visual refinement

- Replace the fixed sidebar on container connections with a compact scope path and an on-demand metadata panel; retain account-level selectors.
- Align scalar fields in compact rows, keep multiline values readable, and reveal field deletion on hover/focus or touch without changing write safeguards.
- Mark changed fields and show exact semantic change counts, including removed fields; clear marks on reversion and explain invalid drafts.
- Unify neutral light/dark surfaces, quiet secondary buttons, line icons and visible keyboard focus.

## 0.13.0 — Result JSON item actions

- Add a context menu to copy one complete top-level result item, including when invoked inside nested or folded content; preserve numeric text.
- Open the complete document using only the item’s own nonempty string id and all partition fields, preserving draft-discard confirmation; incomplete projections remain copyable.
- Support keyboard menu activation/navigation and reject stale targets after page, filter, query or scope changes.
- Build the item range index lazily from the complete result JSON, independently of the rendered viewport; avoid extra discovery queries.

## 0.12.0 — Read-only result JSON viewer

- Reuse CodeMirror for result JSON highlighting, line numbers, gutter folding and local search with match navigation/counts.
- Initialize the result editor only on first JSON-view activation; avoid result formatting in table mode and clear obsolete hidden reader content.
- Copy the complete visible page or local-filter result, preserving numeric text regardless of folds or virtualized lines; export keeps the same scope.
- Reuse the reader and its fold/scroll state while page data is unchanged; invalidate reading state on page/filter/query/scope changes.
- Keep read-only editors keyboard-focusable and count search matches only while the search panel is open.

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
