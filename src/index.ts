// Import styles
import './lib/styles/plugin-control.css';

// Main entry point - Core exports
export { GeoParquetControl, PluginControl } from './lib/core/GeoParquetControl';

// Type exports
export type {
  GeoParquetControlOptions,
  GeoParquetState,
  GeoParquetControlEvent,
  GeoParquetControlEventHandler,
  GeoParquetColumn,
  GeoParquetMetadata,
  GeoParquetFeatureSelection,
  PluginControlOptions,
  PluginState,
  PluginControlEvent,
  PluginControlEventHandler,
} from './lib/core/types';

// Utility exports
export {
  clamp,
  formatNumericValue,
  generateId,
  debounce,
  throttle,
  classNames,
} from './lib/utils';

export {
  escapeSource,
  quoteIdentifier,
  detectPrimaryGeoColumn,
  needsReprojection,
  getSourceCrsString,
  getBboxCovering,
  buildWhereClause,
  buildFilterCondition,
  friendlyError,
} from './lib/geoparquet/utils';
