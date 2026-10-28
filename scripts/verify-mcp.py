"""Verify the installed plugin through a real DBX MCP stdio server.

Opt-in read-only live smoke test. Uses existing host-managed connections;
never prints credentials or document contents and never writes to Cosmos DB.
Example: python3 scripts/verify-mcp.py --binary /absolute/path/dbx-mcp --connection test
"""
import argparse
import json
import os
import select
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', required=True)
parser.add_argument('--connection', action='append', required=True)
parser.add_argument('--partition-key-text', default='["Kintai_DayRecords"]')
args = parser.parse_args()
process = subprocess.Popen([args.binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True,
                           env={**os.environ, 'DBX_MCP_PLUGIN_TOOLS': 'flat'})
identifier = 0


def rpc(method, params):
    global identifier
    identifier += 1
    process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': identifier,
                                   'method': method, 'params': params}) + '\n')
    process.stdin.flush()
    assert select.select([process.stdout], [], [], 60)[0], 'MCP request timed out'
    reply = json.loads(process.stdout.readline())
    assert reply.get('id') == identifier and 'error' not in reply, 'MCP request failed'
    return reply['result']


def call(tool, connection, **arguments):
    result = rpc('tools/call', {'name': 'dbx_cosmosdb__' + tool,
                              'arguments': {'dbx_connection': connection, **arguments}})
    # Avoid putting a failed service reply containing customer data in logs.
    assert not result.get('isError', False), f'{connection}: {tool} failed'
    return json.loads(result['content'][0]['text'])


try:
    initialized = rpc('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                                    'clientInfo': {'name': 'cosmos-plugin-smoke', 'version': '1'}})
    process.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    process.stdin.flush()
    tools = rpc('tools/list', {})['tools']
    cosmos = {tool['name']: tool for tool in tools if tool['name'].startswith('dbx_cosmosdb__')}
    assert set(cosmos) == {'dbx_cosmosdb__' + name for name in
                           ['container_info', 'query', 'read_document', 'cached_partition_keys']}
    for tool in cosmos.values():
        assert tool['annotations']['readOnlyHint'] is True
        assert 'connectionId' not in tool['inputSchema']['properties']
    print('MCP initialize, discovery, read-only annotations and host binding: PASS')
    for connection in args.connection:
        info = call('container_info', connection)
        assert info['mcp_read_only'] is True
        cached_info = call('container_info', connection)
        assert cached_info['metadata_source'] == 'cache' and cached_info['ru'] == 0
        cache = call('cached_partition_keys', connection, filter='Kintai', limit=1)
        assert cache['ru'] == 0 and cache['source'] == 'local_cache'
        query_args = {'sql': 'SELECT c.id FROM c', 'partition_key_text': args.partition_key_text,
                      'page_size': 1}
        page = call('query', connection, **query_args)
        assert page['metadata_source'] == 'cache' and page['metadata_ru'] == 0
        documents = json.loads(page['documents_json'])
        assert len(documents) <= 1
        if documents:
            document = call('read_document', connection, id=documents[0]['id'],
                            partition_key_text=args.partition_key_text)
            assert json.loads(document['document_json'])['id'] == documents[0]['id']
        if page['has_more']:
            assert page['next_cursor']
            call('query', connection, **query_args, cursor=page['next_cursor'])
        refreshed = call('container_info', connection, refresh=True)
        assert refreshed['metadata_source'] == 'live'
        print(f'{connection}: metadata cache/refresh, local keys, partition query, point read and available next page: PASS')
finally:
    process.stdin.close()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
