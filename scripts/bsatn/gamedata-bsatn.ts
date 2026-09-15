import {DbConnection, REMOTE_MODULE} from './bindings/src'
import {AlgebraicType, BinaryWriter} from "spacetimedb";
import * as fs from "node:fs";

fs.existsSync('../../.env.local') && require('dotenv').config({path: '../../.env.local'});

const data_dir = process.env.DATA_DIR || "../../workspace/data/bsatn/static";

!fs.existsSync(data_dir) && fs.mkdirSync(data_dir, {recursive: true});

type KeyPair = {
    camel: string;
    snake: string;
}

interface SchemaResponse {
    tables: [
        {
            name: string;
            table_access: Record<'Public' | 'Private', []>;
        }
    ];
}

async function downloadSchema(host: string, module: string): Promise<SchemaResponse> {
    const response = await fetch(`https://${host}/v1/database/${module}/schema?version=9`);
    if (!response.ok) {
        throw new Error(`Failed to download schema for ${module}: ${response.statusText}`);
    }
    return await response.json();
}

function isStaticTable(tbl: { name: string; table_access: Record<'Public' | 'Private', []> }): boolean {
    if (tbl.table_access['Private']) {
        return false;
    }
    const name = tbl.name;
    if (name.match(/_desc(_v\d+)?$/)) {
        return true;
    }
    if (name.endsWith('_state')) {
        return false;
    }
    const extraTables = ['claim_tile_cost'];
    return extraTables.includes(name);
}

const createOnConnect = (subscriptions: string[], mappings: Map<KeyPair, AlgebraicType>) =>
    (conn: DbConnection) => {
        conn.subscriptionBuilder().onApplied(() => {
            for (let [{camel, snake}, st_type] of mappings.entries()) {
                const table: any = conn.db[camel as keyof typeof conn.db];
                const bw = new BinaryWriter(1024 * 1024);
                let array: any[];
                if (snake === 'building_function_type_mapping_desc') {
                    array = Array.from(table.iter(), (o: any) => {
                        o['descIds'] = o['descIds'].sort((a: number, b: number) => a - b);
                        return o;
                    });
                } else {
                    array = Array.from(table.iter());
                }
                // No sort here: native table order is semantically relevant and is stable in
                // practice (verified across separate runs), so we leave it as delivered.

                AlgebraicType.makeSerializer(st_type)(bw, array);

                // this is the one place we could probably write async and await on all the files at the end,
                // but that seems like too much effort for something already quite fast
                fs.writeFileSync(`${data_dir}/${snake}.bsatn`, bw.getBuffer());
            }

            console.log("Wrote bins");
            const gho = process.env.GITHUB_OUTPUT;
            if (gho) {
                fs.appendFileSync(gho, "updated_data=true\n")
            }

            conn.disconnect();
        }).subscribe(subscriptions);
    };


async function main() {
    const host = process.env.BITCRAFT_SPACETIME_HOST;
    if (!host) {
        throw new Error('BITCRAFT_SPACETIME_HOST is not set');
    }
    let module = process.env.BITCRAFT_REGION_MODULE || 'bitcraft-2';
    const schema: SchemaResponse = await downloadSchema(host, module);

    const subscriptions: string[] = [];
    const mappings = new Map<KeyPair, AlgebraicType>();
    const moduleTables = Object.values(REMOTE_MODULE.tables);

    for (let schemaTable of schema.tables) {
        if (!isStaticTable(schemaTable)) {
            continue;
        }
        const tableKey = schemaTable.name;
        const table = moduleTables.find(t => t.sourceName === tableKey);
        if (!table) {
            throw new Error(`Table ${tableKey} not found in generated bindings`);
        }
        const st_arr_type = AlgebraicType.Array(AlgebraicType.Product(table.rowType));
        mappings.set({camel: table.accessorName, snake: table.sourceName}, st_arr_type);
        subscriptions.push(`SELECT * FROM ${table.sourceName};`)
    }

    return new Promise<void>((resolve, reject) => {
        DbConnection.builder()
            .withUri('wss://' + host)
            .withDatabaseName(module)
            .withToken(process.env.BITCRAFT_BEARER_TOKEN)
            .onConnect(createOnConnect(subscriptions, mappings))
            .onConnectError((_, err) => {
                reject(err);
            })
            .onDisconnect(() => {
                resolve();
            })
            .build()
    });
}

main().then(() => {
    process.exit(0);
}).catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
