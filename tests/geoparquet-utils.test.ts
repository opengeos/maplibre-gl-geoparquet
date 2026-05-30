import { describe, expect, it } from 'vitest';
import {
  buildFilterCondition,
  buildWhereClause,
  detectPrimaryGeoColumn,
  escapeSource,
  friendlyError,
  getSourceCrsString,
  needsReprojection,
} from '../src/lib/geoparquet/utils';
import type { GeoParquetColumn, GeoParquetGeoMetadata } from '../src/lib/core/types';

const schema: GeoParquetColumn[] = [
  { name: 'id', type: 'BIGINT', nullable: false },
  { name: 'geom', type: 'BLOB', nullable: true },
];

describe('GeoParquet utility functions', () => {
  it('escapes SQL string literals', () => {
    expect(escapeSource("Bob's file.parquet")).toBe("Bob''s file.parquet");
  });

  it('detects the primary geometry column from metadata before schema fallback', () => {
    const metadata: GeoParquetGeoMetadata = {
      primary_column: 'geometry',
      columns: { geometry: {} },
    };
    expect(detectPrimaryGeoColumn(schema, metadata)).toBe('geometry');
    expect(detectPrimaryGeoColumn(schema, null)).toBe('geom');
  });

  it('detects whether CRS reprojection is required', () => {
    const wgs84: GeoParquetGeoMetadata = {
      columns: { geom: { crs: { id: { authority: 'EPSG', code: 4326 } } } },
    };
    const britishNationalGrid: GeoParquetGeoMetadata = {
      columns: { geom: { crs: { id: { authority: 'EPSG', code: 27700 } } } },
    };

    expect(needsReprojection(wgs84, 'geom')).toBe(false);
    expect(needsReprojection(britishNationalGrid, 'geom')).toBe(true);
    expect(getSourceCrsString(britishNationalGrid, 'geom')).toContain('27700');
  });

  it('builds bbox covering SQL for viewport filtering', () => {
    const where = buildWhereClause([], [-1, -2, 3, 4], 'geom', {
      xmin: ['bbox', 'xmin'],
      ymin: ['bbox', 'ymin'],
      xmax: ['bbox', 'xmax'],
      ymax: ['bbox', 'ymax'],
    });

    expect(where).toContain('struct_extract("bbox", \'xmax\') >= -1');
    expect(where).toContain('struct_extract("bbox", \'xmin\') <= 3');
  });

  it('rejects unsupported filter operators', () => {
    expect(() =>
      buildFilterCondition({ column: 'name', operator: 'DROP TABLE', value: 'x' })
    ).toThrow('Invalid filter operator');
  });

  it('maps common loading failures to friendly errors', () => {
    expect(friendlyError(new Error('Failed to fetch')).title).toBe('Network error');
    expect(friendlyError(new Error('invalid parquet magic bytes')).title).toBe('Invalid file');
  });
});
