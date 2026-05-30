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

  it('renders pickable toggle and allows multiple local files', () => {
    const { map, mapContainer } = createMapStub();
    const control = new GeoParquetControl({ pickable: false, collapsed: false });

    control.onAdd(map as never);

    const fileInput = mapContainer.querySelector<HTMLInputElement>('.geoparquet-control-file');
    const pickableInput = mapContainer.querySelector<HTMLInputElement>(
      '.geoparquet-control-check input[type="checkbox"]'
    );

    expect(fileInput?.multiple).toBe(true);
    expect(pickableInput?.checked).toBe(false);

    control.setPickable(true);

    expect(control.getState().pickable).toBe(true);
  });

  it('renders layer name and before_id inputs for load options', () => {
    const { map, mapContainer } = createMapStub();
    const control = new GeoParquetControl({
      beforeId: 'settlement-label',
      collapsed: false,
      layerName: 'Countries',
    });

    control.onAdd(map as never);

    const inputs = Array.from(mapContainer.querySelectorAll<HTMLInputElement>('.geoparquet-control-input'));

    expect(inputs.some((input) => input.value === 'Countries')).toBe(true);
    expect(inputs.some((input) => input.value === 'settlement-label')).toBe(true);
  });

  it('shows sample URL without loading it', () => {
    const { map, mapContainer } = createMapStub();
    const sampleUrl = 'https://example.com/sample.parquet';
    const control = new GeoParquetControl({ collapsed: false, sampleUrl });

    control.onAdd(map as never);

    const inputs = Array.from(mapContainer.querySelectorAll<HTMLInputElement>('.geoparquet-control-input'));

    expect(inputs.some((input) => input.value === sampleUrl)).toBe(true);
    expect(control.getState().layers).toHaveLength(0);
  });
});
