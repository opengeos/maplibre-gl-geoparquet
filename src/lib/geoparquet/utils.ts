import { findGeoColumn, formatValue } from '@walkthru-earth/objex-utils';
import type {
  GeoParquetBboxCovering,
  GeoParquetColumn,
  GeoParquetGeoMetadata,
} from '../core/types';
import { ALLOWED_BINARY_OPERATORS, ALLOWED_UNARY_OPERATORS } from './constants';

export interface GeoParquetFilter {
  column: string;
  operator: string;
  value?: string | number | boolean | null;
}

export function escapeSource(source: string): string {
  return source.replace(/'/g, "''");
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function formatDisplayValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength}B]`;
  return formatValue(value);
}

export function normalizeBinary(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

export function detectPrimaryGeoColumn(
  schema: GeoParquetColumn[],
  geoMetadata: GeoParquetGeoMetadata | null
): string | null {
  if (geoMetadata?.primary_column) return geoMetadata.primary_column;
  if (geoMetadata?.columns) {
    const firstColumn = Object.keys(geoMetadata.columns)[0];
    if (firstColumn) return firstColumn;
  }
  return findGeoColumn(schema);
}

export function needsReprojection(
  geoMetadata: GeoParquetGeoMetadata | null,
  primaryGeoColumn: string | null
): boolean {
  if (!geoMetadata?.columns || !primaryGeoColumn) return false;
  const crs = geoMetadata.columns[primaryGeoColumn]?.crs;
  if (!crs) return false;

  const id = crs.id as { authority?: string; code?: string | number } | undefined;
  if (!id) return true;

  const authority = String(id.authority ?? '').toUpperCase();
  const code = String(id.code ?? '').toUpperCase();
  if (authority === 'EPSG' && code === '4326') return false;
  if (authority === 'OGC' && code === 'CRS84') return false;
  return true;
}

export function getSourceCrsString(
  geoMetadata: GeoParquetGeoMetadata | null,
  primaryGeoColumn: string | null
): string | null {
  if (!needsReprojection(geoMetadata, primaryGeoColumn)) return null;
  const crs = geoMetadata?.columns?.[primaryGeoColumn ?? '']?.crs;
  return crs ? JSON.stringify(crs) : null;
}

export function getKnownGeometryType(
  geoMetadata: GeoParquetGeoMetadata | null,
  primaryGeoColumn: string | null
):
  | 'point'
  | 'linestring'
  | 'polygon'
  | 'multipoint'
  | 'multilinestring'
  | 'multipolygon'
  | undefined {
  const types = geoMetadata?.columns?.[primaryGeoColumn ?? '']?.geometry_types;
  if (!types?.length) return undefined;
  const baseTypes = new Set(types.map((type) => type.split(' ')[0]?.toLowerCase()));
  if (baseTypes.size !== 1) return undefined;
  const value = baseTypes.values().next().value;
  if (
    value === 'point' ||
    value === 'linestring' ||
    value === 'polygon' ||
    value === 'multipoint' ||
    value === 'multilinestring' ||
    value === 'multipolygon'
  ) {
    return value;
  }
  return undefined;
}

export function getBboxCovering(
  geoMetadata: GeoParquetGeoMetadata | null,
  primaryGeoColumn: string | null
): GeoParquetBboxCovering | null {
  if (!geoMetadata?.columns || !primaryGeoColumn) return null;
  return geoMetadata.columns[primaryGeoColumn]?.covering?.bbox ?? null;
}

export function getDisplayColumns(
  schema: GeoParquetColumn[],
  geoColumns: string[],
  selectedColumns: string[] | null
): GeoParquetColumn[] {
  const geoColumnSet = new Set(geoColumns);
  const nonGeoColumns = schema.filter(
    (column) => !geoColumnSet.has(column.name) && !column.name.startsWith('__')
  );
  if (!selectedColumns) return nonGeoColumns;
  const selected = new Set(selectedColumns);
  return nonGeoColumns.filter((column) => selected.has(column.name));
}

export function coveringPathToSql(path: string[]): string {
  if (path.length === 0) {
    throw new Error('A GeoParquet bbox covering path cannot be empty');
  }
  let expression = quoteIdentifier(path[0]);
  for (let i = 1; i < path.length; i += 1) {
    expression = `struct_extract(${expression}, '${escapeSource(path[i])}')`;
  }
  return expression;
}

export function buildFilterCondition(filter: GeoParquetFilter): string {
  const column = quoteIdentifier(filter.column);
  const value = escapeSource(String(filter.value ?? ''));

  if (filter.operator === 'LIKE') {
    return `CAST(${column} AS VARCHAR) ILIKE '%${value}%'`;
  }
  if (ALLOWED_UNARY_OPERATORS.has(filter.operator)) {
    return `${column} ${filter.operator}`;
  }
  if (ALLOWED_BINARY_OPERATORS.has(filter.operator)) {
    return `${column} ${filter.operator} '${value}'`;
  }
  throw new Error(`Invalid filter operator: ${filter.operator}`);
}

export function buildWhereClause(
  filters: GeoParquetFilter[] = [],
  bbox: [number, number, number, number] | null = null,
  geoColumn: string | null = null,
  bboxCovering: GeoParquetBboxCovering | null = null
): string {
  const conditions = filters
    .filter(
      (filter) =>
        filter.column &&
        filter.operator &&
        (filter.value !== '' || ALLOWED_UNARY_OPERATORS.has(filter.operator))
    )
    .map((filter) => buildFilterCondition(filter));

  if (bbox && geoColumn && bboxCovering) {
    const [west, south, east, north] = bbox;
    conditions.push(
      `${coveringPathToSql(bboxCovering.xmax)} >= ${west} AND ${coveringPathToSql(
        bboxCovering.xmin
      )} <= ${east} AND ${coveringPathToSql(bboxCovering.ymax)} >= ${south} AND ${coveringPathToSql(
        bboxCovering.ymin
      )} <= ${north}`
    );
  }

  return conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
}

export function friendlyError(error: unknown): { title: string; detail: string; suggestion: string | null } {
  const message = error instanceof Error ? error.message : String(error);

  if (/malloc.*failed|out of memory|memory allocation/i.test(message)) {
    return {
      title: 'Out of memory',
      detail: 'The browser ran out of memory while processing this file.',
      suggestion: 'Try loading fewer rows or selecting fewer columns.',
    };
  }
  if (/fetch|networkerror|failed to fetch|ERR_CONNECTION/i.test(message)) {
    return {
      title: 'Network error',
      detail: 'Could not download the file.',
      suggestion: 'Check the URL, CORS settings, and network connection.',
    };
  }
  if (/CORS|blocked by|access-control-allow-origin/i.test(message)) {
    return {
      title: 'Blocked by CORS',
      detail: 'The remote server does not allow cross-origin requests.',
      suggestion: 'Use a CORS-enabled host or load the file locally.',
    };
  }
  if (/not a parquet|magic bytes|invalid parquet|invalid thrift/i.test(message)) {
    return {
      title: 'Invalid file',
      detail: 'The file does not appear to be a valid Parquet file.',
      suggestion: 'Load a .parquet or .geoparquet file.',
    };
  }
  if (/range request|content-range|HTTP 416/i.test(message)) {
    return {
      title: 'Range requests not supported',
      detail: 'Remote Parquet access requires HTTP range requests.',
      suggestion: 'Use a host that supports range requests or load the file locally.',
    };
  }
  if (/HTTP 4\d\d|HTTP 5\d\d|403|404|500/i.test(message)) {
    const code = message.match(/\b(4\d\d|5\d\d)\b/)?.[0];
    return {
      title: `Server error${code ? ` (${code})` : ''}`,
      detail: 'The server returned an error while fetching the file.',
      suggestion: 'Check that the URL is correct and publicly accessible.',
    };
  }
  if (/_setThrew|stoi.*no conversion/i.test(message)) {
    return {
      title: 'Spatial extension error',
      detail: "DuckDB's spatial extension could not process the CRS.",
      suggestion: 'Try a file with WGS84 coordinates.',
    };
  }

  return {
    title: 'Error',
    detail: message,
    suggestion: null,
  };
}
