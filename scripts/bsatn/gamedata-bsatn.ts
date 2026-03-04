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
            // @ts-ignore - tsconfig targets es2016+ already, not sure what's tripping up mappings.entries() iteration
            for (let [{camel, snake}, st_type] of mappings.entries()) {
                const table: any = conn.db[camel as keyof typeof conn.db];
                const bw = new BinaryWriter(1024 * 1024);
                st_type.serialize(bw, Array.from(table.iter()));
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
    let module = process.env.BITCRAFT_REGION_MODULE || 'bitcraft-2';
    const schema: SchemaResponse = await downloadSchema(process.env.BITCRAFT_SPACETIME_HOST, module);

    const subscriptions: string[] = [];
    const mappings = new Map<KeyPair, AlgebraicType>();

    const moduleTables = new Map(REMOTE_MODULE.tables.map(t => [t.name, t]));
    for (let schemaTable of schema.tables) {
        if (!isStaticTable(schemaTable)) {
            continue;
        }
        const tableKey = schemaTable.name;
        const table = moduleTables.get(tableKey);
        const st_arr_type = AlgebraicType.Array(table.rowType);
        mappings.set({camel: table.name, snake: table.accessorName}, st_arr_type);
        subscriptions.push(`SELECT * FROM ${table.name};`)
    }

    return new Promise<void>((resolve, reject) => {
        DbConnection.builder()
            .withUri('wss://' + process.env.BITCRAFT_SPACETIME_HOST)
            .withModuleName(module)
            .withToken(process.env.BITCRAFT_BEARER_TOKEN)
            .onConnect(createOnConnect(subscriptions, mappings))
            .onConnectError((_, err) => {
                if (err['wasClean']) {
                    resolve()
                } else {
                    reject(err);
                }
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
    if (error['wasClean']) {
        process.exit(0);
    }
    console.error('Error:', error);
    process.exit(1);
});
