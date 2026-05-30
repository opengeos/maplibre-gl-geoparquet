import type { AsyncDuckDB, AsyncDuckDBConnection, DuckDBBundles } from '@duckdb/duckdb-wasm';
import type { Table } from 'apache-arrow';
import type {
  GeoParquetBboxCovering,
  GeoParquetColumn,
  GeoParquetGeoMetadata,
  GeoParquetMetadata,
} from '../core/types';
import { buildWhereClause, escapeSource, quoteIdentifier, type GeoParquetFilter } from './utils';

const DEFAULT_EXTENSION_REPOSITORY = 'https://extensions.duckdb.org';

/**
 * Overrides for where the DuckDB-WASM runtime and its extensions are loaded from.
 *
 * By default the DuckDB-WASM core is fetched from the jsDelivr CDN and the
 * `parquet`/`httpfs`/`spatial` extensions from the official
 * `https://extensions.duckdb.org` repository. Self-hosting both keeps the
 * control working without public CDN access.
 */
export interface DuckDBSourceConfig {
  /**
   * Custom DuckDB-WASM bundles (the core `.wasm` module and worker URLs).
   * When omitted, the jsDelivr CDN bundles are used.
   */
  bundles?: DuckDBBundles;
  /**
   * Base URL of a DuckDB extension repository that mirrors the layout of
   * `extensions.duckdb.org` (i.e. `<base>/<version>/wasm_eh/<name>.duckdb_extension.wasm`).
   * Trailing slashes are ignored. Defaults to `https://extensions.duckdb.org`.
   */
  extensionRepository?: string;
}

let database: AsyncDuckDB | null = null;
let connection: AsyncDuckDBConnection | null = null;
let initPromise: Promise<void> | null = null;
let lastProgressMessage: string | null = null;
const progressListeners = new Set<(message: string) => void>();
const geometryTypeCache = new Map<string, Record<string, boolean>>();

let customBundles: DuckDBBundles | null = null;
let extensionRepository = DEFAULT_EXTENSION_REPOSITORY;

/**
 * Configures where the DuckDB-WASM runtime and extensions are loaded from.
 *
 * Call this once before the first GeoParquet file is loaded (DuckDB is
 * initialized lazily and cached, so changes after initialization have no
 * effect). Pass only the fields you want to override.
 */
export function configureDuckDB(config: DuckDBSourceConfig): void {
  if (config.bundles !== undefined) {
    customBundles = config.bundles;
  }
  if (config.extensionRepository !== undefined) {
    extensionRepository = config.extensionRepository.replace(/\/+$/, '') || DEFAULT_EXTENSION_REPOSITORY;
  }
}

function emitProgress(message: string): void {
  lastProgressMessage = message;
  progressListeners.forEach((listener) => listener(message));
}

export async function initDB(onProgress?: (message: string) => void): Promise<void> {
  if (database && connection) return;

  if (onProgress) {
    progressListeners.add(onProgress);
    if (lastProgressMessage) onProgress(lastProgressMessage);
  }

  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    emitProgress('Loading DuckDB...');
    const duckdb = await import('@duckdb/duckdb-wasm');

    // The DuckDB-WASM core (~35 MB) and the parquet/httpfs/spatial extensions
    // (~26 MB) are fetched at runtime rather than bundled, keeping the published
    // package small. By default they come from the jsDelivr CDN and
    // extensions.duckdb.org, but both can be overridden via configureDuckDB for
    // self-hosting. selectBundle picks the build that matches the browser's WASM
    // feature support (eh, mvp, coi).
    const bundle = await duckdb.selectBundle(customBundles ?? duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    database = new duckdb.AsyncDuckDB(logger, worker);

    emitProgress('Starting DuckDB...');
    await database.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    await database.open({});

    emitProgress('Opening database connection...');
    connection = await database.connect();

    emitProgress('Preloading coordinate systems...');
    await connection.query('SELECT * FROM duckdb_coordinate_systems()');

    // Resolve the DuckDB version so extensions are pulled from the matching
    // build on the official signed-extension repository.
    const versionResult = await connection.query('SELECT version() AS version');
    const duckdbVersion = String(versionResult.toArray()[0].version);
    const extensionRepo = `${extensionRepository}/${duckdbVersion}/wasm_eh`;

    const loadExtension = async (name: string) => {
      emitProgress(`Loading ${name} extension...`);
      await connection!.query(`LOAD '${extensionRepo}/${name}.duckdb_extension.wasm'`);
    };

    await loadExtension('parquet');
    await loadExtension('httpfs');
    await loadExtension('spatial');
    progressListeners.clear();
  })();

  await initPromise;
}

export async function getDB(): Promise<AsyncDuckDB> {
  if (!database) await initDB();
  return database!;
}

export async function query(sql: string): Promise<Table> {
  if (!connection) await initDB();
  const result = await connection!.query(sql);
  return result as unknown as Table;
}

export async function registerLocalFile(name: string, buffer: ArrayBuffer): Promise<void> {
  const db = await getDB();
  await db.registerFileBuffer(name, new Uint8Array(buffer));
}

export async function dropFile(name: string): Promise<void> {
  const db = await getDB();
  try {
    await db.dropFile(name);
  } catch {
    // DuckDB throws when the file is already absent. That is harmless for cleanup.
  }
}

export async function getSchema(source: string): Promise<GeoParquetColumn[]> {
  const result = await query(`DESCRIBE SELECT * FROM read_parquet('${escapeSource(source)}')`);
  return result.toArray().map((row) => ({
    name: String(row.column_name),
    type: String(row.column_type),
    nullable: String(row.null) === 'YES',
  }));
}

export function cacheSchemaGeomTypes(source: string, schema: GeoParquetColumn[]): void {
  const entry: Record<string, boolean> = {};
  schema.forEach((column) => {
    entry[column.name] = column.type.toUpperCase().startsWith('GEOMETRY');
  });
  geometryTypeCache.set(source, entry);
}

export async function isGeometryType(source: string, geoColumn: string): Promise<boolean> {
  const cached = geometryTypeCache.get(source);
  if (cached && geoColumn in cached) return cached[geoColumn];
  const schema = await getSchema(source);
  cacheSchemaGeomTypes(source, schema);
  return geometryTypeCache.get(source)?.[geoColumn] ?? false;
}

function blobToString(value: unknown): string {
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return String(value);
}

function geometryExpression(geoColumn: string, alreadyGeometry: boolean): string {
  return alreadyGeometry ? quoteIdentifier(geoColumn) : `ST_GeomFromWKB(${quoteIdentifier(geoColumn)})`;
}

export async function bootstrapMetadata(
  source: string,
  onProgress: (message: string) => void = () => {}
): Promise<GeoParquetMetadata> {
  const escaped = escapeSource(source);

  onProgress('Reading schema...');
  const schema = await getSchema(source);
  cacheSchemaGeomTypes(source, schema);

  onProgress('Reading row group metadata...');
  let rowGroupSize: number | null = null;
  try {
    const rowGroupResult = await query(
      `SELECT FIRST(row_group_num_rows) AS first_rg_size FROM parquet_metadata('${escaped}') LIMIT 1`
    );
    const row = rowGroupResult.toArray()[0];
    const value = Number(row.first_rg_size);
    rowGroupSize = value > 0 ? value : null;
  } catch {
    rowGroupSize = null;
  }

  onProgress('Reading file metadata...');
  let fileInfo: Record<string, unknown> | null = null;
  let totalRows = -1;
  try {
    const fileResult = await query(`SELECT * FROM parquet_file_metadata('${escaped}')`);
    const row = fileResult.toArray()[0];
    fileInfo = {};
    fileResult.schema.fields.forEach((field) => {
      const value = row[field.name];
      fileInfo![field.name] = typeof value === 'bigint' ? Number(value) : value;
    });
    totalRows = Number(fileInfo.num_rows ?? -1);
  } catch {
    const countResult = await query(`SELECT COUNT(*) AS cnt FROM read_parquet('${escaped}')`);
    totalRows = Number(countResult.toArray()[0].cnt);
  }

  onProgress('Reading GeoParquet metadata...');
  let kvMetadata: Record<string, unknown> | null = null;
  let geoMetadata: GeoParquetGeoMetadata | null = null;
  try {
    const kvResult = await query(`SELECT key, value FROM parquet_kv_metadata('${escaped}')`);
    kvMetadata = {};
    kvResult.toArray().forEach((row) => {
      const key = blobToString(row.key);
      let value: unknown = blobToString(row.value);
      try {
        value = JSON.parse(String(value));
      } catch {
        // Keep non-JSON metadata as plain text.
      }
      kvMetadata![key] = value;
    });
    if (kvMetadata.geo && typeof kvMetadata.geo === 'object') {
      geoMetadata = kvMetadata.geo as GeoParquetGeoMetadata;
    }
  } catch {
    kvMetadata = null;
    geoMetadata = null;
  }

  return { schema, totalRows, rowGroupSize, geoMetadata, fileInfo, kvMetadata };
}

export async function transformBbox(
  bbox: [number, number, number, number],
  sourceCrs: string,
  targetCrs: string
): Promise<[number, number, number, number]> {
  const [west, south, east, north] = bbox;
  const sourceLiteral = escapeSource(sourceCrs);
  const targetLiteral = escapeSource(targetCrs);
  const result = await query(
    `SELECT ST_XMin(g) AS minx, ST_YMin(g) AS miny, ST_XMax(g) AS maxx, ST_YMax(g) AS maxy
     FROM (SELECT ST_Transform(ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}), '${sourceLiteral}', '${targetLiteral}', true) AS g)`
  );
  const row = result.toArray()[0];
  return [Number(row.minx), Number(row.miny), Number(row.maxx), Number(row.maxy)];
}

export async function queryCount(
  source: string,
  filters: GeoParquetFilter[] = [],
  bbox: [number, number, number, number] | null = null,
  geoColumn: string | null = null,
  sourceCrs: string | null = null,
  bboxCovering: GeoParquetBboxCovering | null = null
): Promise<number> {
  const effectiveBbox =
    bbox && bboxCovering && sourceCrs ? await transformBbox(bbox, 'EPSG:4326', sourceCrs) : bbox;
  const where = buildWhereClause(filters, effectiveBbox, geoColumn, bboxCovering);
  const result = await query(`SELECT COUNT(*) AS cnt FROM read_parquet('${escapeSource(source)}')${where}`);
  return Number(result.toArray()[0].cnt);
}

export async function queryData(
  source: string,
  {
    geoColumn = null,
    filters = [],
    bbox = null,
    sourceCrs = null,
    limit = null,
    offset = 0,
    alreadyGeometry = null,
    columns = null,
    bboxCovering = null,
  }: {
    geoColumn?: string | null;
    filters?: GeoParquetFilter[];
    bbox?: [number, number, number, number] | null;
    sourceCrs?: string | null;
    limit?: number | null;
    offset?: number;
    alreadyGeometry?: boolean | null;
    columns?: string[] | null;
    bboxCovering?: GeoParquetBboxCovering | null;
  } = {}
): Promise<Table> {
  let isAlreadyGeometry = alreadyGeometry;
  if (isAlreadyGeometry === null && geoColumn) {
    isAlreadyGeometry = await isGeometryType(source, geoColumn);
  }

  const effectiveBbox =
    bbox && bboxCovering && sourceCrs ? await transformBbox(bbox, 'EPSG:4326', sourceCrs) : bbox;
  const where = buildWhereClause(filters, effectiveBbox, geoColumn, bboxCovering);

  let geometrySelect = '';
  if (geoColumn) {
    const baseExpression = geometryExpression(geoColumn, Boolean(isAlreadyGeometry));
    if (sourceCrs) {
      const crsLiteral = escapeSource(sourceCrs);
      geometrySelect = `, ST_AsWKB(ST_Transform(${baseExpression}, '${crsLiteral}', 'EPSG:4326', true)) AS __wkb`;
    } else {
      geometrySelect = `, ST_AsWKB(${baseExpression}) AS __wkb`;
    }
  }

  const selectedColumns = columns?.length ? columns.map((column) => quoteIdentifier(column)).join(', ') : '*';
  const pagination =
    limit !== null ? ` LIMIT ${limit} OFFSET ${offset}` : offset > 0 ? ` OFFSET ${offset}` : '';
  return query(
    `SELECT ${selectedColumns}${geometrySelect} FROM read_parquet('${escapeSource(source)}')${where}${pagination}`
  );
}
