# Runtime behavior and data access

This document describes the release candidate for DBX Store review. The plugin source is MIT licensed. The vendored DBX Go SDK is Apache-2.0; bundled frontend dependency licenses are shipped under `ui/licenses/`.

## Host integration and credentials

- Adds a Cosmos DB for NoSQL connection provider and a sandboxed workbench.
- Manifest permissions are empty. This does not sandbox the native Go sidecar's operating-system access.
- DBX owns saved connections and Secret Store credential persistence. The Account Key field uses `binding: secret`; the workbench UI is not given the Account Key.
- The Go sidecar receives the active connection credentials through the DBX connection lifecycle and holds them in memory. It does not persist Account Keys received from the connection lifecycle or authorization headers, and it does not automatically cache returned document bodies. User-authored query input is stored separately as described below.

## Network and document access

- The sidecar signs Cosmos REST requests with the supplied Account Key and sends them to the endpoint configured by the user. Production account endpoints use HTTPS. Loopback HTTP endpoints are allowed for local tests/emulators; non-loopback HTTP endpoints are rejected.
- Account/database/container metadata, partition range metadata, document queries, and point reads go to that configured endpoint. Partition discovery can consume RU, shows cumulative charges, uses a cache, and pauses at its budget. It does not fall back to a full document scan when index seeking is unsupported.
- Read-only connections are enforced by the backend. Writable connections permit user-confirmed single-document create, conditional Patch/replace, and conditional delete. Existing-document changes use ETags. The plugin does not execute bulk writes or arbitrary operating-system commands.
- The UI uses locally bundled CodeMirror/language extensions. It does not load a CDN, contact a telemetry service, or request dynamic code compilation privileges.

## Local files and processes

- DBX launches the Go sidecar over the plugin JSON-RPC protocol. The production sidecar does not launch child processes or open a listening TCP port.
- The sidecar writes a partition-key cache under the operating-system user cache directory (`dbx-plugin-cosmosdb/partition-keys-v1/`). Cache keys incorporate endpoint and connection/container identity as a hash. Files contain discovered partition values, progress and timestamps, not document bodies or credentials. Directories use 0700 and files 0600 on Unix-like systems.
- Column widths are atomically persisted in private `table-layout-v1` files below `DBX_PLUGIN_DATA_DIR`, falling back to the user config directory. Paths hash endpoint, connection and container identity. Files are limited to 128 KiB, contain column names and dimensions only, and use 0600 permissions on Unix-like systems. Legacy visibility and pinning preferences are ignored; all returned fields are shown and id remains pinned.
- The selected database/container pair is atomically persisted in `selected-scope-v1` below the same private data root, isolated by hashed endpoint and connection identity. Records contain only the version, database, container and a random revision, are limited to 8 KiB on read, and use 0700 directories / 0600 files on Unix-like systems. The workbench and MCP share this location. Existing connection defaults migrate after successful connection validation; the plugin does not rewrite DBX connection records or credentials. Invalid or inaccessible saved locations require explicit reselection instead of silently choosing another container.
- Plugin-wide result/document view preferences are atomically persisted in `view-preferences-v1.json` under the same private data root. The versioned record contains only the enum values `table`/`json` and `fields`/`json`, with a 4 KiB read limit and 0600 files on Unix-like systems. Result and document choices merge independently; invalid records fall back to defaults. No SQL, parameters, document data or credentials are stored in this view-preference file.
- Query input is atomically persisted as private `query-input-v1` records below the same data root, isolated by hashed endpoint, connection, database and container identity. Records contain the raw SQL, partition-key text, parameter text and page size, including unfinished syntax. SQL is limited to 256 KiB, parameter text to 128 KiB, partition text to 16 KiB and the encoded record/read to 2 MiB. Directories use 0700 and files 0600 on Unix-like systems. SQL literals and parameters may contain sensitive values; these records are local plaintext files protected by operating-system permissions, not encryption. They are not synchronized or exposed through MCP. Reopening restores input only; it never executes queries or starts discovery. Reset query overwrites this scope's saved input with defaults.
- Unsaved document drafts, results, undo history and learned completion field names remain in memory. Field-name learning does not trigger network scans. In-flight local saves are not guaranteed after forced termination or sudden power loss.
- Export is an explicit user action through DBX's `host.saveFile`; it exports the current result page only, with a 1 MiB limit.
- Test servers, Azure validation scripts, package verification helpers, and identity migration notes are repository tooling. They are not included in the installed plugin.

## External MCP surface (0.9.0 onward)

- Opts into DBX's external MCP bridge; the built-in AI surface is explicitly disabled. Version 0.16.0 requires DBX 0.6.59+ and is validated with MCP Server 0.4.134. The manifest declares `access: read` for each of the four tools, alongside their `readOnlyHint` annotations. External access requires a DBX capability grant and visible, permitted connections; users enable the plugin with a Read only authorization ceiling in Settings → MCP → Capabilities.
- Exposes only `container_info`, `query`, `read_document` and `cached_partition_keys`. The dedicated MCP dispatcher rejects all other tool names and unknown/tool-inappropriate arguments, constructs a read-only client from the host lifecycle, and never routes to arbitrary `cosmos/*` methods. A writable UI connection does not enable MCP writes.
- Requires a host-bound connection ID matching the lifecycle and the plugin-managed selected database/container pair (with legacy connection defaults accepted when no private record exists). New connections must first select a complete location in the workbench. No caller-supplied endpoint, credentials or database/container overrides are accepted. Changing the workbench location changes subsequent MCP calls for that connection. DBX and the MCP client must separately restrict visible connections and exposed tool names.
- Queries require a complete explicit partition-key array, default to 20 rows and cap the requested service page at 100. Query/point-read calls validate the full partition-key component count using a five-minute in-memory container-definition cache (up to 128 entries), scoped to endpoint, connection, credential identity and container. Explicit container_info refresh bypasses it. Container-related 400/404 responses invalidate it for the next call, without automatic retries. Source and timestamps are returned; total RU includes only metadata reads actually performed. Calls never auto-page, retry or enumerate partitions. Cached key lookup reads only the local historical cache.
- Partition keys, parameter values and document results use JSON text strings to avoid host-side number rounding. Results are untrusted data, not instructions. Text output is limited to 192 KiB before MCP envelope serialization; oversized results fail with available RU/timing rather than silently truncating documents.
- Opaque random continuation handles are scoped to connection/endpoint/container, selected-location revision, credential identity and all query inputs. Up to 256 handles live only in sidecar memory for 10 minutes; no document bodies or credentials are stored in them. Restarting the sidecar or changing the saved location invalidates handles, including when switching back to the original container.

## Known boundaries

The first published target is macOS ARM64. Authentication is Account Key only; Entra ID, SSH/DBX proxy routing, automatic region failover, bulk operations and full SDK cross-partition query pipelines are not supported. Completion suggestions are based on a basic Cosmos SQL vocabulary and already-read document fields, not a complete container schema or SQL semantic validator.

Please report reproducible bugs using [GitHub issues](https://github.com/fwrq41251/dbx-plugin-cosmosdb/issues). Do not include Account Keys, authorization headers, private endpoint addresses or business documents in public reports.

UI query cancellation applies only to document queries, never mutations. Bounded per-connection query IDs handle cancellation arriving before request registration; completed/canceled entries expire after one minute. Cancellation closes the client HTTP request but does not refund RU or assert that the server stopped before doing any work.

### Native query workspaces (0.25.0)

`workbenches-v1` stores only each host workbench's selected database/container and
whether it was created by New Query. `query-input-workbench-v1` stores the same
plaintext SQL, parameter, partition-key and page-size inputs described above,
isolated by endpoint, connection, workbench and container. Existing native tabs
restore their own records; restoration never executes SQL. Query results,
document content and unsaved document drafts remain in memory. Explicit New
Query tabs do not overwrite the ordinary connection-reopen input fallback.
Directories use 0700 and files 0600 on macOS/Linux; these are access permissions,
not encryption. These UI records are not exposed through MCP.
