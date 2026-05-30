# MapLibre GL GeoParquet

A MapLibre GL JS control for visualizing GeoParquet interactively in the browser.

The control loads remote GeoParquet URLs or local files, reads metadata and rows with
DuckDB-WASM, and renders GeoArrow data on the host map with deck.gl. It does not replace
or manage the map basemap.

## Features

- MapLibre `IControl` implementation with a compact collapsible button
- Remote URL and local file loading
- GeoParquet metadata inspection
- Column selection and page size controls
- Interactive point, line, and polygon rendering with deck.gl
- CRS reprojection to WGS84 when GeoParquet metadata provides a non-WGS84 CRS
- Viewport reload when GeoParquet bbox covering metadata is available
- TypeScript and React entry points

## Installation

```bash
npm install maplibre-gl-geoparquet
```

## Usage

### TypeScript

```typescript
import maplibregl from 'maplibre-gl';
import { GeoParquetControl } from 'maplibre-gl-geoparquet';
import 'maplibre-gl-geoparquet/style.css';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [0, 0],
  zoom: 2,
});

map.on('load', () => {
  map.addControl(
    new GeoParquetControl({
      title: 'GeoParquet',
      collapsed: false,
      sourceUrl: 'https://example.com/data.parquet',
    }),
    'top-right'
  );
});
```

### React

```tsx
import { GeoParquetControlReact, useGeoParquetState } from 'maplibre-gl-geoparquet/react';
import 'maplibre-gl-geoparquet/style.css';

function GeoParquetLayer({ map }) {
  const { setState } = useGeoParquetState();

  return (
    <GeoParquetControlReact
      map={map}
      title="GeoParquet"
      sourceUrl="https://example.com/data.parquet"
      onStateChange={setState}
    />
  );
}
```

## API

### `GeoParquetControlOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `collapsed` | `boolean` | `true` | Whether the panel starts collapsed |
| `position` | `string` | `'top-right'` | Default control position |
| `title` | `string` | `'GeoParquet'` | Panel title and button label |
| `panelWidth` | `number` | `340` | Floating panel width in pixels |
| `className` | `string` | `''` | Extra class on the control button container |
| `sourceUrl` | `string` | `undefined` | Remote GeoParquet URL to load on add |
| `pageSize` | `number` | `10000` | Rows loaded per query |
| `selectedColumns` | `string[]` | `null` | Attribute columns to load |
| `fitBoundsOnLoad` | `boolean` | `true` | Fit the map to loaded data |
| `allowLocalFiles` | `boolean` | `true` | Enable local file input |
| `allowRemoteUrls` | `boolean` | `true` | Enable remote URL input |

### Methods

- `loadUrl(url: string): Promise<void>`
- `loadFile(file: File): Promise<void>`
- `clear(): void`
- `loadMore(): Promise<void>`
- `reloadViewport(): Promise<void>`
- `getState(): GeoParquetState`
- `on(event, handler): void`
- `off(event, handler): void`

### Events

`collapse`, `expand`, `statechange`, `loadstart`, `progress`, `load`, `error`, and `select`.

Legacy aliases `PluginControl`, `PluginControlReact`, and `usePluginState` are exported for
template migration, but new code should use the GeoParquet names.

## Development

```bash
npm install
npm run load-extensions
npm run dev
```

The DuckDB `parquet`, `httpfs`, and `spatial` WASM extensions are downloaded into
`extensions/` during builds.

## Scripts

| Script | Description |
|---|---|
| `npm run load-extensions` | Download DuckDB WASM extensions |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Build the library |
| `npm run build:examples` | Build the examples site |
| `npm test` | Run Vitest |
| `npm run lint` | Run ESLint |
| `npm run format` | Format source files |

## Docker

```bash
docker build -t maplibre-gl-geoparquet .
docker run -p 8080:80 maplibre-gl-geoparquet
```

Open http://localhost:8080/maplibre-gl-geoparquet/.


## Acknowledgments

This project is inspired by the work in
[moregeo-it/geoparquet-viewer](https://github.com/moregeo-it/geoparquet-viewer/),
including its GeoParquet loading, metadata, and browser visualization workflows.