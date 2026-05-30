import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeoParquetControl } from '../src';

vi.mock('@deck.gl/mapbox', () => ({
  MapboxOverlay: class {
    setProps = vi.fn();
  },
}));

vi.mock('@geoarrow/deck.gl-layers', () => ({
  GeoArrowPathLayer: class {},
  GeoArrowPolygonLayer: class {},
  GeoArrowScatterplotLayer: class {},
}));

function createMapStub() {
  const mapContainer = document.createElement('div');
  document.body.appendChild(mapContainer);
  const controls = new Set<unknown>();

  return {
    mapContainer,
    map: {
      getContainer: () => mapContainer,
      addControl: (control: unknown) => controls.add(control),
      removeControl: (control: unknown) => controls.delete(control),
      hasControl: (control: unknown) => controls.has(control),
      on: vi.fn(),
      off: vi.fn(),
      triggerRepaint: vi.fn(),
      getCanvas: () => document.createElement('canvas'),
      getBounds: () => ({
        getWest: () => -1,
        getSouth: () => -2,
        getEast: () => 3,
        getNorth: () => 4,
      }),
      getZoom: () => 2,
      fitBounds: vi.fn(),
      flyTo: vi.fn(),
    },
  };
}

describe('GeoParquetControl', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('creates the compact button and floating panel', () => {
    const { map, mapContainer } = createMapStub();
    const control = new GeoParquetControl({ title: 'GeoParquet', collapsed: true });

    const container = control.onAdd(map as never);

    expect(container.querySelector('.geoparquet-control-toggle')).toBeTruthy();
    expect(mapContainer.querySelector('.geoparquet-control-panel')).toBeTruthy();
    expect(control.getState().collapsed).toBe(true);
  });

  it('emits expand and collapse events when toggled', () => {
    const { map } = createMapStub();
    const control = new GeoParquetControl();
    const expandHandler = vi.fn();
    const collapseHandler = vi.fn();

    control.on('expand', expandHandler);
    control.on('collapse', collapseHandler);
    control.onAdd(map as never);

    control.expand();
    control.collapse();

    expect(expandHandler).toHaveBeenCalledTimes(1);
    expect(collapseHandler).toHaveBeenCalledTimes(1);
  });

  it('removes panel and button on cleanup', () => {
    const { map, mapContainer } = createMapStub();
    const control = new GeoParquetControl();
    const container = control.onAdd(map as never);
    mapContainer.appendChild(container);

    control.onRemove();

    expect(mapContainer.querySelector('.geoparquet-control-panel')).toBeNull();
    expect(container.parentNode).toBeNull();
  });
});
