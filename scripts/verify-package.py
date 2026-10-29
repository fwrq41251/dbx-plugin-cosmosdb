"""Check a package and run its native sidecar against a disposable local service.

Usage: python scripts/verify-package.py dist/<native-package>.dbxp
No Azure account, credentials or user plugin data are used.
"""
import base64
import hashlib
import hmac
import http.server
import json
import os
import pathlib
import platform
import queue
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import zipfile


class Cosmos(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        is_container = '/colls/' in self.path
        resource_type = 'colls' if is_container else 'dbs'
        resource_link = self.path.strip('/') if is_container else ''
        date = self.headers['x-ms-date']
        payload = f'get\n{resource_type}\n{resource_link}\n{date.lower()}\n\n'.encode()
        signature = base64.b64encode(hmac.new(b'test-account-key', payload, hashlib.sha256).digest()).decode()
        expected = 'type=master&ver=1.0&sig=' + signature
        assert urllib.parse.unquote_plus(self.headers['Authorization']) == expected
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        if is_container:
            body = {'id': self.path.rsplit('/', 1)[-1], 'partitionKey': {'paths': ['/tenant']}}
        else:
            body = {'Databases': [{'id': 'package-smoke'}]}
        self.wfile.write(json.dumps(body).encode())

    def log_message(self, *args):
        pass


def verify(package):
    package = package.resolve()
    metadata = json.loads(package.with_suffix('.artifact.json').read_text(encoding='utf-8'))
    assert hashlib.sha256(package.read_bytes()).hexdigest() == metadata['sha256']
    assert package.stat().st_size == metadata['size']
    host_os = {'Darwin': 'darwin', 'Windows': 'windows', 'Linux': 'linux'}[platform.system()]
    host_arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}[platform.machine().lower()]
    assert metadata['target'] == f'{host_os}-{host_arch}', 'Run lifecycle verification on the target platform'
    with tempfile.TemporaryDirectory(prefix='cosmos-package-') as directory:
        with zipfile.ZipFile(package) as archive:
            checksums = json.loads(archive.read('checksums.json'))['files']
            expected = set(checksums) | {'checksums.json'}
            if 'signature.json' in archive.namelist():
                expected.add('signature.json')
                signature = json.loads(archive.read('signature.json'))
                assert signature['algorithm'] == 'ed25519'
                assert signature['key_id'] == metadata['signingKeyId']
                assert len(base64.b64decode(signature['signature'], validate=True)) == 64
                # DBX verifies the signature against its trusted store key on install.
                # This script checks the envelope, payload and sidecar lifecycle only.
            assert set(archive.namelist()) == expected
            for name, digest in checksums.items():
                parts = pathlib.PurePosixPath(name).parts
                assert '..' not in parts and not name.startswith('/') and '\\' not in name and ':' not in name
                assert hashlib.sha256(archive.read(name)).hexdigest() == digest, name
            manifest = json.loads(archive.read('manifest.json'))
            assert manifest['id'] == 'io.github.fwrq41251.cosmosdb'
            assert manifest['permissions'] == []
            assert 'ui/licenses/DBX-Apache-2.0.txt' in checksums
            for dependency in ['codemirror', 'codemirror-lang-json', 'codemirror-lang-sql', 'lezer-highlight']:
                assert f'ui/licenses/{dependency}-LICENSE.txt' in checksums
            entry = manifest['entrypoints']['backend']['executable']
            assert entry.startswith(f"bin/{metadata['target']}/"), 'Sidecar path does not match artifact target'
            assert entry.endswith('.exe') == (host_os == 'windows'), 'Wrong executable suffix'
            executable = pathlib.Path(directory) / pathlib.PurePosixPath(entry).name
            executable.write_bytes(archive.read(entry))
            executable.chmod(0o700)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Cosmos)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        # Both paths are disposable. The smoke test must never touch a user's
        # actual plugin records or partition cache on any OS.
        environment = {**os.environ, 'DBX_PLUGIN_DATA_DIR': str(pathlib.Path(directory) / 'plugin-data')}
        process = subprocess.Popen([str(executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, encoding='utf-8', env=environment)
        replies = queue.Queue()

        def read_replies():
            # select() on a subprocess pipe is unsupported on Windows. A reader
            # thread + bounded queue wait also handles EOF and buffered lines.
            try:
                for line in process.stdout:
                    replies.put(line)
            finally:
                replies.put(None)

        reader = threading.Thread(target=read_replies, daemon=True)
        reader.start()

        def call(method, params, identifier):
            process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params}) + '\n')
            process.stdin.flush()
            try:
                line = replies.get(timeout=10)
            except queue.Empty as error:
                raise AssertionError(f'Sidecar timed out: {method}') from error
            assert line is not None, f'Sidecar exited before replying: {method}'
            reply = json.loads(line)
            assert reply['id'] == identifier and 'error' not in reply, reply
            return reply['result']

        try:
            result = call('plugin/initialize', {'host': {'protocolVersions': [1]}}, 1)
            assert result['protocolVersion'] == 1
            assert result['plugin'] == {'id': manifest['id'], 'version': manifest['version']}
            connection = {'id': 'smoke', 'host': f'http://127.0.0.1:{server.server_port}',
                          'connection_secrets': {'account_key': base64.b64encode(b'test-account-key').decode()}}
            assert call('connection/connect', {'connection': connection}, 2)['success']
            a = {'connectionId': 'smoke', 'workbenchId': 'smoke-a'}
            assert call('cosmos/info', a, 3)['readOnly']
            assert json.loads(call('cosmos/databases', a, 4)['json'])[0]['id'] == 'package-smoke'
            selected = {**a, 'database': 'package-smoke', 'container': 'Orders'}
            assert call('cosmos/selectScope', selected, 5)['container'] == 'Orders'
            input_value = {'sql': 'SELECT * FROM c WHERE c.id = @id', 'partitionKeyText': '["テスト"]',
                           'parametersText': '[{"name":"@id","value":9223372036854775807}]', 'pageSize': 250}
            assert call('cosmos/queryInput', {**selected, 'queryInput': input_value}, 6) == input_value
            # Replacing existing files exercises Windows rename semantics.
            input_value['sql'] += '\n'
            assert call('cosmos/queryInput', {**selected, 'queryInput': input_value}, 7) == input_value
            assert call('cosmos/queryInput', selected, 8) == input_value
            b = {'connectionId': 'smoke', 'workbenchId': 'smoke-b'}
            assert call('cosmos/info', {**b, 'newQuery': True, 'sourceWorkbenchId': 'smoke-a'}, 9)['container'] == 'Orders'
            assert call('cosmos/queryInput', {**selected, **b}, 10)['sql'] == 'SELECT * FROM c'
            assert call('cosmos/selectScope', {**b, 'database': 'package-smoke', 'container': 'Archive'}, 11)['container'] == 'Archive'
            assert call('cosmos/info', a, 12)['container'] == 'Orders'
            assert call('cosmos/info', b, 13)['container'] == 'Archive'
            assert call('connection/disconnect', {'connection': {'id': 'smoke'}}, 14)['success']
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            reader.join(timeout=2)
            process.stdout.close()
            process.stderr.close()
            server.shutdown()
            server.server_close()
        assert process.returncode == 0
    print(f'{metadata["target"]}: package SHA-256, file checksums, licenses, protocol v1, lifecycle and workspace persistence: PASS')


if __name__ == '__main__':
    verify(pathlib.Path(sys.argv[1]))
