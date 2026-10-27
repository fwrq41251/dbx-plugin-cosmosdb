"""Check package integrity and the packaged native sidecar against protocol v1.

Usage: python3 scripts/verify-package.py dist/<native-package>.dbxp
Uses a disposable local HTTP service, never an Azure account.
"""
import base64
import hashlib
import hmac
import http.server
import json
import pathlib
import select
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import zipfile


class Cosmos(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        date = self.headers['x-ms-date']
        payload = f'get\ndbs\n\n{date.lower()}\n\n'.encode()
        signature = base64.b64encode(hmac.new(b'test-account-key', payload, hashlib.sha256).digest()).decode()
        expected = 'type=master&ver=1.0&sig=' + signature
        assert urllib.parse.unquote_plus(self.headers['Authorization']) == expected
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"Databases":[{"id":"package-smoke"}]}')

    def log_message(self, *args):
        pass


package = pathlib.Path(sys.argv[1]).resolve()
metadata = json.loads(package.with_suffix('.artifact.json').read_text())
assert hashlib.sha256(package.read_bytes()).hexdigest() == metadata['sha256']
assert package.stat().st_size == metadata['size']
with tempfile.TemporaryDirectory(prefix='cosmos-package-') as directory:
    with zipfile.ZipFile(package) as archive:
        checksums = json.loads(archive.read('checksums.json'))['files']
        assert set(archive.namelist()) == set(checksums) | {'checksums.json'}
        for name, digest in checksums.items():
            assert '..' not in pathlib.PurePosixPath(name).parts and not name.startswith('/')
            assert hashlib.sha256(archive.read(name)).hexdigest() == digest, name
        manifest = json.loads(archive.read('manifest.json'))
        assert manifest['id'] == 'io.github.fwrq41251.cosmosdb'
        assert manifest['permissions'] == []
        assert 'ui/licenses/DBX-Apache-2.0.txt' in checksums
        for dependency in ['codemirror', 'codemirror-lang-json', 'codemirror-lang-sql', 'lezer-highlight']:
            assert f'ui/licenses/{dependency}-LICENSE.txt' in checksums
        executable = pathlib.Path(directory) / pathlib.Path(manifest['entrypoints']['backend']['executable']).name
        executable.write_bytes(archive.read(manifest['entrypoints']['backend']['executable']))
        executable.chmod(0o700)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Cosmos)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    process = subprocess.Popen([str(executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def call(method, params, identifier):
        process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params}) + '\n')
        process.stdin.flush()
        assert select.select([process.stdout], [], [], 10)[0], 'sidecar timed out'
        reply = json.loads(process.stdout.readline())
        assert reply['id'] == identifier and 'error' not in reply, reply
        return reply['result']

    try:
        result = call('plugin/initialize', {'host': {'protocolVersions': [1]}}, 1)
        assert result['protocolVersion'] == 1
        assert result['plugin'] == {'id': manifest['id'], 'version': manifest['version']}
        connection = {'id': 'smoke', 'host': f'http://127.0.0.1:{server.server_port}', 'connection_secrets': {'account_key': base64.b64encode(b'test-account-key').decode()}}
        assert call('connection/connect', {'connection': connection}, 2)['success']
        assert call('cosmos/info', {'connectionId': 'smoke'}, 3)['readOnly']
        assert json.loads(call('cosmos/databases', {'connectionId': 'smoke'}, 4)['json'])[0]['id'] == 'package-smoke'
        assert call('connection/disconnect', {'connection': {'id': 'smoke'}}, 5)['success']
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        server.shutdown()
    assert process.returncode == 0
print('Package SHA-256, file checksums, licenses, protocol v1 and connection lifecycle: PASS')
