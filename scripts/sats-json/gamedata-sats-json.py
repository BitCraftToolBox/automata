import json
import os
import re
import uuid
from pathlib import Path

import requests
from dotenv import load_dotenv
from websockets import Subprotocol
from websockets.exceptions import WebSocketException
from websockets.sync.client import connect

uri = '{scheme}://{host}/v1/database/{module}/{endpoint}'
proto = Subprotocol('v1.json.spacetimedb')


def get_tables(host, module, table_names, auth):
    save_data = {}
    try:
        with connect(
                uri.format(scheme='wss', host=host, module=module, endpoint='subscribe'),
                # user_agent_header='BitCraftToolBox/automata',
                additional_headers={"Authorization": auth} if auth else {},
                subprotocols=[proto],
                max_size=None,
                max_queue=None
        ) as ws:
            # STDB sends an IdentityToken message first. Just read it out and ignore the contents.
            ws.recv()
            # one off queries only support one statement, so we only send one at a time, and put all the results in the dict
            for table_name in table_names:
                query = json.dumps(dict(OneOffQuery=dict(
                    # the message id will be returned to us so we can match query and response, but we don't actually care so just generate and forget
                    message_id=str(uuid.uuid4()).replace('-', ''),
                    query_string=f'SELECT * FROM {table_name};'
                )))
                ws.send(query)
                for msg in ws:
                    data = json.loads(msg)
                    if 'OneOffQueryResponse' in data:
                        if 'some' in data['OneOffQueryResponse']['error']:
                            raise ValueError(data['OneOffQueryResponse']['error']['some'])
                        table_data = data['OneOffQueryResponse']['tables']
                        # because we're only doing one table at once, this *should* be singular,
                        # but technically the spec allows for multiple
                        for table in table_data:
                            name = table['table_name']
                            rows = table['rows']
                            save_data[name] = [json.loads(row) for row in rows]
                        break
                    else:
                        print('Unexpected message returned: ' + data)
                        raise ValueError
    except WebSocketException as ex:
        raise ex

    return save_data


def table_names_to_file(schema, table_file):
    tables = schema.get("tables", [])
    tables = {t['name']: 'Public' in t['table_access'] for t in tables}
    public = [k for k, v in tables.items() if v]
    private = [k for k, v in tables.items() if not v]
    rls = schema.get("row_level_security", [])
    rls.sort(key=lambda x: x['sql'])
    with open(table_file, 'w') as f:
        json.dump(dict(public=public, private=private, row_level_security=rls), fp=f, indent=2)


def download_schema(host, module):
    target = uri.format(scheme='https', host=host, module=module, endpoint='schema')
    res = requests.get(target, params=dict(version=9))
    return res.json() if res.status_code == 200 else None


def get_schema(hostname):
    schema_glb = download_schema(hostname, 'bitcraft-global')
    schema_reg = download_schema(hostname, 'bitcraft-2')
    return schema_glb, schema_reg


_desc_re = re.compile(r".+_desc(_v\d+)?$")


def _is_static_table(tbl):
    if 'Public' not in tbl['table_access']:
        return False
    name = tbl['name']
    if _desc_re.match(name):
        return True
    if name.endswith('_state'):
        return False
    extra_tables = ['claim_tile_cost']
    if name in extra_tables:
        return True
    return False


def save_tables(data_dir, tables):
    def _get_sort(x):
        # incredibly ugly but ok
        return x.get('id', x.get('item_id', x.get('building_id', x.get('name', x.get('cargo_id', x.get('type_id', -1))))))

    for name, data in tables.items():
        data = sorted(data, key=_get_sort)
        with open(data_dir / (name + '.json'), 'w') as f:
            json.dump(data, fp=f, indent=2)


def main():
    data_dir = Path(os.getenv('DATA_DIR') or 'workspace/data/sats-json')
    data_dir.mkdir(parents=True, exist_ok=True)
    stdb_host = os.getenv('BITCRAFT_SPACETIME_HOST')
    if not stdb_host:
        raise ValueError('BITCRAFT_SPACETIME_HOST not set')
    auth = os.getenv('BITCRAFT_BEARER_TOKEN') or None
    auth = ('Bearer ' + auth) if auth else None

    schema_glb, schema_reg = get_schema(stdb_host)
    table_names_to_file(schema_glb, data_dir / 'global_tables.json')
    table_names_to_file(schema_reg, data_dir / 'region_tables.json')

    static_tables = [t['name'] for t in schema_glb.get("tables", []) if _is_static_table(t)]

    static_dir = data_dir / 'static'
    static_dir.mkdir(parents=True, exist_ok=True)

    # would like to get the static data from the global db, but it has a few empty tables
    static_data = get_tables(stdb_host, 'bitcraft-2', static_tables, auth)
    save_tables(static_dir, static_data)


if __name__ == '__main__':
    load_dotenv('.env.local', verbose=False)
    main()

    if _gho := os.getenv('GITHUB_OUTPUT'):
        with open(_gho, 'a') as _gho_f:
            _gho_f.write(f'updated_data=true')
