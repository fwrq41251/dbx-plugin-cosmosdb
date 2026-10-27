"""Opt-in Azure CUD validation using a temporary test container.

Requires Azure CLI login and explicit --run. Never targets an existing container.
Credentials stay in memory and are not saved to DBX or printed. The temporary
container and this test's local key cache are removed in finally. Serverless
accounts use request-based capacity; provisioned accounts use 400 RU/s.
"""
import argparse
import hashlib
import json
import pathlib
import select
import subprocess
import sys
import tempfile
import uuid
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("resource-group", "account", "database", "package"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--run", action="store_true", required=True)
    args = parser.parse_args()
    container = "dbx-cud-validation-" + uuid.uuid4().hex
    connection_id = "live-cud-" + uuid.uuid4().hex
    scope = ["-g", args.resource_group, "-a", args.account, "-d", args.database, "-n", container]
    endpoint = f"https://{args.account}.documents.azure.com:443/"
    attempted = False
    process = None
    identifier = 0

    def az(*command):
        result = subprocess.run(["az", *command, "--only-show-errors", "-o", "json"], capture_output=True, text=True)
        if result.returncode:
            if command[:3] == ("cosmosdb", "sql", "container"):
                raise RuntimeError("Container management failed: " + result.stderr[:2400])
            raise RuntimeError("Azure CLI operation failed; credentials and upstream output withheld")
        return json.loads(result.stdout) if result.stdout.strip() else None

    def call(method, params, expected_error=None):
        nonlocal identifier
        identifier += 1
        process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}) + "\n")
        process.stdin.flush()
        if not select.select([process.stdout], [], [], 70)[0]:
            raise RuntimeError("Packaged backend timed out")
        response = json.loads(process.stdout.readline())
        if response.get("id") != identifier:
            raise RuntimeError("Unexpected protocol response")
        if expected_error:
            message = response.get("error", {}).get("message", "")
            if expected_error not in message:
                raise RuntimeError("Expected rejection missing: " + expected_error)
            print(method + ": expected rejection PASS", flush=True)
            return None
        if "error" in response:
            raise RuntimeError("Backend operation failed: " + method + ": " + response["error"].get("message", ""))
        result = response["result"]
        print(f"{method}: PASS" + (f" ({result['ru']:.2f} RU)" if "ru" in result else ""), flush=True)
        return result

    try:
        if az("cosmosdb", "sql", "container", "exists", *scope):
            raise RuntimeError("Temporary container already exists; refusing to use it")
        attempted = True
        account = az("cosmosdb", "show", "-g", args.resource_group, "-n", args.account)
        serverless = any(c.get("name") == "EnableServerless" for c in account.get("capabilities", []))
        capacity = [] if serverless else ["--throughput", "400"]
        az("cosmosdb", "sql", "container", "create", *scope, "--partition-key-path", "/tenant", *capacity, "--ttl", "3600")
        print("Temporary isolated test container created", flush=True)
        keys = az("cosmosdb", "keys", "list", "-g", args.resource_group, "-n", args.account, "--type", "keys")
        with tempfile.TemporaryDirectory(prefix="dbx-live-cud-") as directory:
            with zipfile.ZipFile(args.package) as archive:
                manifest = json.loads(archive.read("manifest.json"))
                executable = pathlib.Path(directory) / "sidecar"
                executable.write_bytes(archive.read(manifest["entrypoints"]["backend"]["executable"]))
                executable.chmod(0o700)
            process = subprocess.Popen([str(executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            call("plugin/initialize", {"host": {"protocolVersions": [1]}})
            connection = {"id": connection_id, "host": endpoint, "connection_secrets": {"account_key": keys["primaryMasterKey"]}, "external_config": {"database_id": args.database, "container_id": container, "read_only": True}}
            call("connection/connect", {"connection": connection})
            identity = {"connectionId": connection_id, "database": args.database, "container": container, "id": "validation-document", "partitionKeyText": '["validation"]'}
            document = {"id": identity["id"], "tenant": "validation", "status": "created", "amount": 42}
            create = {**identity, "documentText": json.dumps(document)}
            call("cosmos/create", create, "read-only")
            call("cosmos/patch", {**identity, "etag": '"readonly"', "operationsText": '[{"op":"set","path":"/amount","value":43}]'}, "read-only")
            connection["external_config"]["read_only"] = False
            call("connection/connect", {"connection": connection})
            created = call("cosmos/create", create)
            assert json.loads(created["json"])["status"] == "created"
            call("cosmos/create", create, "HTTP 409")
            call("cosmos/create", {**create, "documentText": json.dumps({**document, "tenant": "wrong"})}, "分区键")
            document["status"] = "updated"
            updated = call("cosmos/replace", {**identity, "etag": created["etag"], "documentText": json.dumps(document)})
            assert json.loads(updated["json"])["status"] == "updated"
            patch = {**identity, "etag": updated["etag"], "operationsText": '[{"op":"set","path":"/amount","value":43},{"op":"set","path":"/note","value":"patched"}]'}
            patched = call("cosmos/patch", patch)
            assert json.loads(patched["json"])["amount"] == 43
            assert json.loads(patched["json"])["note"] == "patched"
            assert json.loads(patched["json"])["status"] == "updated"
            call("cosmos/patch", patch, "HTTP 412")
            call("cosmos/patch", {**identity, "etag": patched["etag"], "operationsText": '[{"op":"set","path":"/tenant","value":"other"}]'}, "不能修改")
            call("cosmos/replace", {**identity, "etag": created["etag"], "documentText": json.dumps(document)}, "HTTP 412")
            read = call("cosmos/read", identity)
            assert json.loads(read["json"])["status"] == "updated"
            call("cosmos/delete", {**identity, "etag": created["etag"]}, "HTTP 412")
            call("cosmos/delete", {**identity, "etag": patched["etag"]})
            call("cosmos/read", identity, "HTTP 404")
            cache = call("cosmos/partitionCache", identity)
            assert '["validation"]' not in cache["keys"]
            call("connection/disconnect", {"connection": {"id": connection_id}})
    finally:
        if process:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if attempted:
            if az("cosmosdb", "sql", "container", "exists", *scope):
                az("cosmosdb", "sql", "container", "delete", *scope, "--yes")
            assert not az("cosmosdb", "sql", "container", "exists", *scope)
            print("Temporary test container cleanup: absence verified", flush=True)
        identity = json.dumps([endpoint.rstrip("/"), connection_id, args.database, container], separators=(",", ":"))
        cache_root = pathlib.Path.home() / ("Library/Caches" if sys.platform == "darwin" else ".cache")
        cache_file = cache_root / "dbx-plugin-cosmosdb" / "partition-keys-v1" / (hashlib.sha256(identity.encode()).hexdigest() + ".json")
        cache_file.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
