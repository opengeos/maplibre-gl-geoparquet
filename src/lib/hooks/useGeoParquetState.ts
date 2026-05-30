import { useCallback, useState } from 'react';
import type { GeoParquetState } from '../core/types';
import { DEFAULT_PAGE_SIZE, DEFAULT_PANEL_WIDTH } from '../geoparquet/constants';

const DEFAULT_STATE: GeoParquetState = {
  collapsed: true,
  panelWidth: DEFAULT_PANEL_WIDTH,
  source: null,
  displaySource: '',
  loading: false,
  statusMessage: '',
  error: null,
  schema: [],
  selectedColumns: null,
  pageSize: DEFAULT_PAGE_SIZE,
  totalRows: -1,
  loadedRows: 0,
  hasMore: false,
  primaryGeoColumn: null,
  selectedFeature: null,
  metadata: null,
};

export function useGeoParquetState(initialState?: Partial<GeoParquetState>) {
  const [state, setState] = useState<GeoParquetState>({
    ...DEFAULT_STATE,
    ...initialState,
  });

  const setCollapsed = useCallback((collapsed: boolean) => {
    setState((previous) => ({ ...previous, collapsed }));
  }, []);

  const setPanelWidth = useCallback((panelWidth: number) => {
    setState((previous) => ({ ...previous, panelWidth }));
  }, []);

  const reset = useCallback(() => {
    setState({ ...DEFAULT_STATE, ...initialState });
  }, [initialState]);

  const toggle = useCallback(() => {
    setState((previous) => ({ ...previous, collapsed: !previous.collapsed }));
  }, []);

  return {
    state,
    setState,
    setCollapsed,
    setPanelWidth,
    reset,
    toggle,
  };
}

export const usePluginState = useGeoParquetState;
