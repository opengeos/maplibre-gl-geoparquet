import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const extensionsDir = join(rootDir, 'extensions');
const require = createRequire(import.meta.url);

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function getDuckDBVersion() {
  const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const wasmPath = join(rootDir, 'node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm');
  const bundles = { eh: { mainModule: wasmPath, mainWorker: null } };
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  db.open({});
  const conn = db.connect();
  const version = conn.query('SELECT version() AS version').toArray()[0].version;
  conn.close();
  return version;
}

const duckdbVersion = await getDuckDBVersion();
const extensionUrls = ['parquet', 'httpfs', 'spatial'].map(
  (name) =>
    `https://extensions.duckdb.org/${duckdbVersion}/wasm_eh/${name}.duckdb_extension.wasm`
);

await mkdir(extensionsDir, { recursive: true });

for (const url of extensionUrls) {
  const filename = url.split('/').at(-1);
  const dest = join(extensionsDir, filename);
  if (!filename) {
    throw new Error(`Could not derive extension filename from ${url}`);
  }
  if (await fileExists(dest)) {
    console.log(`${filename} already exists`);
    continue;
  }

  process.stdout.write(`Downloading ${filename}... `);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(dest, buffer);
  console.log(`saved (${(buffer.length / 1024).toFixed(1)} KB)`);
}
