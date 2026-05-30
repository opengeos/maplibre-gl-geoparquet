// React entry point
export { GeoParquetControlReact, PluginControlReact } from './lib/core/GeoParquetControlReact';

// React hooks
export { useGeoParquetState, usePluginState } from './lib/hooks';

// Re-export types for React consumers
export type {
  GeoParquetControlOptions,
  GeoParquetState,
  GeoParquetControlReactProps,
  GeoParquetControlEvent,
  GeoParquetControlEventHandler,
  GeoParquetFeatureSelection,
  GeoParquetLayerState,
  PluginControlOptions,
  PluginState,
  PluginControlReactProps,
  PluginControlEvent,
  PluginControlEventHandler,
} from './lib/core/types';
