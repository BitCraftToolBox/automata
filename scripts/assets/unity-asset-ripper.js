// originally by Kattoor https://gist.github.com/Kattoor/49c3e24d80d0c767365e4961d8f0e6ba
//
// Drives AssetRipper's local web server: loads the client, exports the Unity Project (YAML) and
// saves every shader's parsed form (pass state) through the asset API. Paths default to the CI
// layout; ASSETS_WORKSPACE, ASSETRIPPER_EXE and ASSET_FOLDER override them for local runs.

import {spawn} from 'child_process';
import {EOL} from 'os';
import {request} from 'http';
import path from 'path';
import fs from 'fs';

const workspaceDir = path.resolve(process.env.ASSETS_WORKSPACE ?? path.resolve(import.meta.dirname, '../../workspace/assets'));
const assetRipperPath = process.env.ASSETRIPPER_EXE ?? path.join(workspaceDir, 'AssetRipper.GUI.Free');
const assetFolderPath = process.env.ASSET_FOLDER ?? path.join(workspaceDir, 'depots/3454651');
// Unity Project export (YAML .asset/.prefab/.mat/.meta, sprites, fonts, translations); every
// publisher reads it (see MODELS.md). The workflow deletes it after the last publisher.
const unityProjectOutPath = path.join(workspaceDir, 'extracted-project');
// One `<shader name with / as _>.json` per shader: its parsed form, which holds the pass state
// (blend factors, ZWrite, ColorMask, queue) the Unity Project export drops.
const shaderOutPath = path.join(workspaceDir, 'extracted-shaders');

let port;

function startAssetRipperAndListenToStdOut(executablePath) {
    let buffer = '';

    const child = spawn(executablePath, [], {stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true});
    process.on('exit', () => child.kill());

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', async (chunk) => {
        buffer += chunk;
        const lines = buffer.split(EOL);
        buffer = lines.pop() || '';

        for (const line of lines) {
            await processStdOutLine(line);
        }
    });

}

const stdoutActions = [
    {
        match: /Now listening on: http:\/\/127\.0\.0\.1:(\d+)/,
        action: (match) => {
            port = match[1];
            console.log(`Port found: ${port}`);
            console.log(`Loading folder ${assetFolderPath}`);
            loadFolder(port, assetFolderPath);
        }
    },
    {
        match: /Processing : Finished processing assets/,
        action: () => {
            console.log('Folder loaded.');
            console.log(`Exporting Unity project to ${unityProjectOutPath}`);
            // A leftover non-empty directory here would make AssetRipper wait on a deletion
            // confirmation prompt it has no headless way to answer, hanging the job forever.
            fs.rmSync(unityProjectOutPath, {recursive: true, force: true});
            exportUnityProject(port, unityProjectOutPath);
        }
    },
    {
        match: / : \((\d+)\/(\d+)\) Exporting '(.*)'/,
        action: (match) => {
            const [, index, total, file] = match;
            console.log(`Extracting file ${index} of ${total}: ${file}`);
        }
    },
    {
        match: /Export : Finished post-export/,
        action: async () => {
            console.log('Finished exporting the Unity project.');
            try {
                const count = await saveShaders(port, shaderOutPath);
                if (!count) throw new Error('no shaders found');
                console.log(`Saved ${count} shaders to ${shaderOutPath}.`);
                process.exit(0);
            } catch (err) {
                console.error(`Saving shaders failed: ${err.stack ?? err}`);
                process.exit(1);
            }
        }
    }
];

async function processStdOutLine(line) {
    for (const {match, action} of stdoutActions) {
        const result = line.match(match);
        if (result) {
            action(result);
            break;
        }
    }
}

async function loadFolder(port, folderPath) {
    const body = new URLSearchParams({path: folderPath});
    post(port, '/LoadFolder', body);
}

async function exportUnityProject(port, outputFolderPath) {
    const body = new URLSearchParams({path: outputFolderPath});
    post(port, '/Export/UnityProject', body);
}

function post(port, path, body) {
    const req = request({
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'}
    });
    req.write(body.toString());
    req.end();
}

async function get(port, pathAndQuery) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`);
    if (!res.ok) throw new Error(`GET ${pathAndQuery.slice(0, 80)} -> ${res.status}`);
    return res.text();
}

/**
 * Walks every bundle and collection the server has loaded, then writes each Shader asset's JSON.
 * Links in the server's HTML carry the `Path` query exactly as the API expects it, so they are
 * followed as-is. Returns the number of shaders saved.
 */
async function saveShaders(port, outDir) {
    const html = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const bundles = [encodeURIComponent('{"P":[]}')];
    const seenBundles = new Set(bundles);
    const collections = new Set();
    for (let i = 0; i < bundles.length; i++) {
        const page = await get(port, `/Bundles/View?Path=${bundles[i]}`);
        for (const [, p] of page.matchAll(/href="\/Collections\/View\?Path=([^"]*)"/g)) collections.add(html(p));
        for (const [, p] of page.matchAll(/href="\/Bundles\/View\?Path=([^"]*)"/g)) {
            const link = html(p);
            if (!seenBundles.has(link)) {
                seenBundles.add(link);
                bundles.push(link);
            }
        }
    }

    const shaders = new Map();
    for (const collection of collections) {
        const page = await get(port, `/Collections/View?Path=${collection}`);
        for (const [, p] of page.matchAll(/<td>Shader<\/td><td><a href="\/Assets\/View\?Path=([^"]*)"/g)) shaders.set(html(p), true);
    }

    // Shaders sharing a name (several URP Lit, FlatKit variants, ...) are the same shader loaded
    // from different files and have identical pass state, so one file per name is enough; the
    // publishers strip the project export's `_<n>` suffix to find it. Warn if that stops holding.
    const byName = new Map();
    const queue = [...shaders.keys()];
    await Promise.all(Array.from({length: 8}, async () => {
        for (let p = queue.pop(); p !== undefined; p = queue.pop()) {
            const json = await get(port, `/Assets/Json?Path=${p}`);
            const parsed = JSON.parse(json);
            if (!parsed.m_Name) throw new Error(`shader without a name at ${p}`);
            const passState = JSON.stringify((parsed.m_ParsedForm?.m_SubShaders ?? []).map((s) => (s.m_Passes ?? []).map((pass) => pass.m_State)));
            (byName.get(parsed.m_Name) ?? byName.set(parsed.m_Name, []).get(parsed.m_Name)).push({p, json, passState});
        }
    }));

    fs.rmSync(outDir, {recursive: true, force: true});
    fs.mkdirSync(outDir, {recursive: true});
    for (const [name, variants] of byName) {
        variants.sort((a, b) => (a.p < b.p ? -1 : 1));
        if (new Set(variants.map((v) => v.passState)).size > 1) console.warn(`Shader "${name}": ${variants.length} variants differ in pass state; saving the first by path`);
        fs.writeFileSync(path.join(outDir, `${name.replace(/[\\/:*?"<>|]/g, '_')}.json`), variants[0].json);
    }
    return byName.size;
}

await startAssetRipperAndListenToStdOut(assetRipperPath);
