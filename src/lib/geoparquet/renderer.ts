import { MapboxOverlay } from '@deck.gl/mapbox';
import {
  GeoArrowPathLayer,
  GeoArrowPolygonLayer,
  GeoArrowScatterplotLayer,
} from '@geoarrow/deck.gl-layers';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { GeoArrowResult } from '@walkthru-earth/objex-utils';

const NORMAL_FILL = [51, 153, 204, 120] as [number, number, number, number];
const NORMAL_LINE = [51, 153, 204, 220] as [number, number, number, number];
const SELECTED_FILL = [255, 152, 0, 165] as [number, number, number, number];
const SELECTED_LINE = [230, 120, 0, 255] as [number, number, number, number];
const HIGHLIGHT = [255, 200, 0, 160] as [number, number, number, number];

type DeckInfo = {
  picked?: boolean;
  object?: Record<string, unknown>;
  index?: number;
  x?: number;
  y?: number;
};

export interface GeoParquetRendererOptions {
  onSelect: (index: number | null) => void;
}

export class GeoParquetRenderer {
  private map: MapLibreMap;
  private overlay: MapboxOverlay;
  private selectedIndex: number | null = null;
  private onSelect: (index: number | null) => void;

  constructor(map: MapLibreMap, options: GeoParquetRendererOptions) {
    this.map = map;
    this.onSelect = options.onSelect;
    this.overlay = new MapboxOverlay({ layers: [], interleaved: false });
    this.map.addControl(this.overlay);
  }

  setSelectedIndex(index: number | null): void {
    this.selectedIndex = index;
  }

  setData(results: GeoArrowResult[]): void {
    const layers = results.flatMap((result, index) => this.createLayers(result, index));
    this.overlay.setProps({ layers: layers as never[] });
    this.map.triggerRepaint();
  }

  clear(): void {
    this.overlay.setProps({ layers: [] });
    this.map.triggerRepaint();
  }

  remove(): void {
    this.clear();
    if (this.map.hasControl(this.overlay)) {
      this.map.removeControl(this.overlay);
    }
  }

  private rowIndex(info: DeckInfo): number | null {
    const value = info.object?.__index;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') return Number(value);
    return null;
  }

  private createLayers(result: GeoArrowResult, index: number): unknown[] {
    const layerId = `geoparquet-${result.geometryType}-${index}`;
    const indexColumn = result.table.getChild('__index');
    const indexValues = indexColumn ? indexColumn.toArray() : null;
    const isSelected = (objectInfo: { index: number }) =>
      this.selectedIndex !== null && indexValues !== null && indexValues[objectInfo.index] === this.selectedIndex;
    const handleHover = (info: DeckInfo) => {
      this.map.getCanvas().style.cursor = info.object ? 'pointer' : '';
    };
    const handleClick = (info: DeckInfo) => {
      if (!info.picked) return false;
      const indexValue = this.rowIndex(info);
      if (indexValue === null) return false;
      this.selectedIndex = indexValue === this.selectedIndex ? null : indexValue;
      this.onSelect(this.selectedIndex);
      return true;
    };

    if (result.geometryType === 'point' || result.geometryType === 'multipoint') {
      return [
        new GeoArrowScatterplotLayer({
          id: layerId,
          data: result.table,
          getFillColor: (objectInfo: { index: number }) =>
            isSelected(objectInfo) ? SELECTED_FILL : NORMAL_FILL,
          getRadius: 6,
          radiusUnits: 'pixels',
          radiusMinPixels: 4,
          radiusMaxPixels: 12,
          pickable: true,
          autoHighlight: true,
          highlightColor: HIGHLIGHT,
          _validate: false,
          onHover: handleHover,
          onClick: handleClick,
          updateTriggers: {
            getFillColor: [this.selectedIndex],
          },
        }),
      ];
    }

    if (result.geometryType === 'linestring' || result.geometryType === 'multilinestring') {
      return [
        new GeoArrowPathLayer({
          id: layerId,
          data: result.table,
          getColor: (objectInfo: { index: number }) => (isSelected(objectInfo) ? SELECTED_LINE : NORMAL_LINE),
          getWidth: 2.5,
          widthUnits: 'pixels',
          widthMinPixels: 1.5,
          pickable: true,
          autoHighlight: true,
          highlightColor: HIGHLIGHT,
          _validate: false,
          onHover: handleHover,
          onClick: handleClick,
          updateTriggers: {
            getColor: [this.selectedIndex],
          },
        }),
      ];
    }

    return [
      new GeoArrowPolygonLayer({
        id: layerId,
        data: result.table,
        getFillColor: (objectInfo: { index: number }) =>
          isSelected(objectInfo) ? SELECTED_FILL : NORMAL_FILL,
        getLineColor: (objectInfo: { index: number }) =>
          isSelected(objectInfo) ? SELECTED_LINE : NORMAL_LINE,
        getLineWidth: 2,
        lineWidthMinPixels: 1.5,
        pickable: true,
        autoHighlight: true,
        highlightColor: HIGHLIGHT,
        _validate: false,
        onHover: handleHover,
        onClick: handleClick,
        updateTriggers: {
          getFillColor: [this.selectedIndex],
          getLineColor: [this.selectedIndex],
        },
      }),
    ];
  }
}
