import type { Map } from 'maplibre-gl';
import type { GeoArrowResult } from '@walkthru-earth/objex-utils';

export type GeoParquetControlPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface GeoParquetColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface GeoParquetGeoMetadata {
  version?: string;
  primary_column?: string;
  columns?: Record<string, GeoParquetGeoColumnMetadata>;
}

export interface GeoParquetGeoColumnMetadata {
  encoding?: string;
  geometry_types?: string[];
  bbox?: [number, number, number, number];
  crs?: Record<string, unknown> | null;
  covering?: {
    bbox?: GeoParquetBboxCovering;
  };
}

export interface GeoParquetBboxCovering {
  xmin: string[];
  ymin: string[];
  xmax: string[];
  ymax: string[];
}

export interface GeoParquetMetadata {
  schema: GeoParquetColumn[];
  totalRows: number;
  rowGroupSize: number | null;
  geoMetadata: GeoParquetGeoMetadata | null;
  fileInfo: Record<string, unknown> | null;
  kvMetadata: Record<string, unknown> | null;
}

export interface GeoParquetFeatureSelection {
  index: number;
  properties: Record<string, unknown>;
}

export interface GeoParquetState {
  collapsed: boolean;
  panelWidth: number;
  source: string | null;
  displaySource: string;
  loading: boolean;
  statusMessage: string;
  error: string | null;
  schema: GeoParquetColumn[];
  selectedColumns: string[] | null;
  pageSize: number;
  totalRows: number;
  loadedRows: number;
  hasMore: boolean;
  primaryGeoColumn: string | null;
  selectedFeature: GeoParquetFeatureSelection | null;
  metadata: GeoParquetMetadata | null;
}

export interface GeoParquetControlOptions {
  collapsed?: boolean;
  position?: GeoParquetControlPosition;
  title?: string;
  panelWidth?: number;
  className?: string;
  sourceUrl?: string;
  pageSize?: number;
  selectedColumns?: string[];
  fitBoundsOnLoad?: boolean;
  allowLocalFiles?: boolean;
  allowRemoteUrls?: boolean;
}

export interface GeoParquetControlReactProps extends GeoParquetControlOptions {
  map: Map;
  onStateChange?: (state: GeoParquetState) => void;
  onLoad?: (state: GeoParquetState) => void;
  onError?: (error: Error, state: GeoParquetState) => void;
  onSelect?: (selection: GeoParquetFeatureSelection | null, state: GeoParquetState) => void;
}

export type GeoParquetControlEvent =
  | 'collapse'
  | 'expand'
  | 'statechange'
  | 'loadstart'
  | 'progress'
  | 'load'
  | 'error'
  | 'select';

export interface GeoParquetControlEventData {
  type: GeoParquetControlEvent;
  state: GeoParquetState;
  error?: Error;
  selection?: GeoParquetFeatureSelection | null;
}

export type GeoParquetControlEventHandler = (event: GeoParquetControlEventData) => void;

export interface LoadedGeoArrowData {
  results: GeoArrowResult[];
  wkbByIndex: Record<number, Uint8Array>;
}

export type PluginControlOptions = GeoParquetControlOptions;
export type PluginState = GeoParquetState;
export type PluginControlReactProps = GeoParquetControlReactProps;
export type PluginControlEvent = GeoParquetControlEvent;
export type PluginControlEventHandler = GeoParquetControlEventHandler;
