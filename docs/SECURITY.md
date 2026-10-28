# Runtime behavior and data access

This document describes the release candidate for DBX Store review. The plugin source is MIT licensed. The vendored DBX Go SDK is Apache-2.0; bundled frontend dependency licenses are shipped under `ui/licenses/`.

## Host integration and credentials

- Adds a Cosmos DB for NoSQL connection provider and a sandboxed workbench.
- Manifest permissions are empty. This does not sandbox the native Go sidecar's operating-system access.
- DBX owns saved connections and Secret Store credential persistence. The Account Key field uses `binding: secret`; the workbench UI is not given the Account Key.
- The Go sidecar receives the active connection credentials through the DBX connection lifecycle and holds them in memory. It does not write Account Keys, authorization headers, or document bodies to its cache or logs.

## Network and document access

- The sidecar signs Cosmos REST requests with the supplied Account Key and sends them to the endpoint configured by the user. Production account endpoints use HTTPS. Loopback HTTP endpoints are allowed for local tests/emulators; non-loopback HTTP endpoints are rejected.
- Account/database/container metadata, partition range metadata, document queries, and point reads go to that configured endpoint. Partition discovery can consume RU, shows cumulative charges, uses a cache, and pauses at its budget. It does not fall back to a full document scan when index seeking is unsupported.
- Read-only connections are enforced by the backend. Writable connections permit user-confirmed single-document create, conditional Patch/replace, and conditional delete. Existing-document changes use ETags. The plugin does not execute bulk writes or arbitrary operating-system commands.
- The UI uses locally bundled CodeMirror/language extensions. It does not load a CDN, contact a telemetry service, or request dynamic code compilation privileges.

## Local files and processes

- DBX launches the Go sidecar over the plugin JSON-RPC protocol. The production sidecar does not launch child processes or open a listening TCP port.
- The sidecar writes a partition-key cache under the operating-system user cache directory (`dbx-plugin-cosmosdb/partition-keys-v1/`). Cache keys incorporate endpoint and connection/container identity as a hash. Files contain discovered partition values, progress and timestamps, not document bodies or credentials. Directories use 0700 and files 0600 on Unix-like systems.
- Document/query drafts and learned completion field names are in memory. Field-name learning does not trigger network scans.
- Export is an explicit user action through DBX's `host.saveFile`; it exports the current result page only, with a 1 MiB limit.
- Test servers, Azure validation scripts, package verification helpers, and identity migration notes are repository tooling. They are not included in the installed plugin.

## External MCP surface (0.9.0 candidate)

- Opts into DBX's external MCP bridge; the built-in AI surface is explicitly disabled. The validated stable pair is DBX 0.6.58 / MCP Server 0.4.132. This uses the stable manifest's `external_tools` plus per-tool `readOnlyHint`; it does not claim compatibility with 0.4.134's newer manifest access declarations and grants.
- Exposes only `container_info`, `query`, `read_document` and `cached_partition_keys`. The dedicated MCP dispatcher rejects all other tool names and unknown/tool-inappropriate arguments, constructs a read-only client from the host lifecycle, and never routes to arbitrary `cosmos/*` methods. A writable UI connection does not enable MCP writes.
- Requires a host-bound connection ID matching the lifecycle and a saved database/container pair. No caller-supplied endpoint, credentials or database/container overrides are accepted. DBX and the MCP client must separately restrict visible connections and exposed tool names.
- Queries require a complete explicit partition-key array, default to 20 rows and cap the requested service page at 100. Query/point-read calls first validate the complete partition-key component count against current container metadata; total RU includes this metadata cost and reports it separately. Calls never auto-page, retry or enumerate partitions. Cached key lookup reads only the local historical cache.
- Partition keys, parameter values and document results use JSON text strings to avoid host-side number rounding. Results are untrusted data, not instructions. Text output is limited to 192 KiB before MCP envelope serialization; oversized results fail with available RU/timing rather than silently truncating documents.
- Opaque random continuation handles are scoped to connection/endpoint/container, credential identity and all query inputs. Up to 256 handles live only in sidecar memory for 10 minutes; no document bodies or credentials are stored in them. Restarting the sidecar invalidates handles.

## Known boundaries

The first published target is macOS ARM64. Authentication is Account Key only; Entra ID, SSH/DBX proxy routing, automatic region failover, bulk operations and full SDK cross-partition query pipelines are not supported. Completion suggestions are based on a basic Cosmos SQL vocabulary and already-read document fields, not a complete container schema or SQL semantic validator.

Please report reproducible bugs using [GitHub issues](https://github.com/fwrq41251/dbx-plugin-cosmosdb/issues). Do not include Account Keys, authorization headers, private endpoint addresses or business documents in public reports.
