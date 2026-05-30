# MapLibre GL GeoParquet

A MapLibre GL JS control for visualizing GeoParquet interactively in the browser.

The control loads remote GeoParquet URLs or local files, reads metadata and rows with
DuckDB-WASM, and renders GeoArrow data on the host map with deck.gl. It does not replace
or manage the map basemap.

## Features

- MapLibre `IControl` implementation with a compact collapsible button
- Remote URL and local file loading
- Multiple GeoParquet files loaded as separate map layers
- GeoParquet metadata inspection
- Column selection and page size controls
- Interactive point, line, and polygon rendering with deck.gl
- Optional feature picking with attribute popups
- User-configurable layer names and `beforeId` placement for deck.gl layers
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
      sourceUrls: [
        'https://example.com/roads.parquet',
        'https://example.com/buildings.parquet',
      ],
      pickable: true,
      layerName: 'Countries',
      beforeId: 'settlement-label',
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
      sourceUrls={[
        'https://example.com/roads.parquet',
        'https://example.com/buildings.parquet',
      ]}
      pickable
      beforeId="settlement-label"
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
| `sourceUrls` | `string[]` | `undefined` | Multiple remote GeoParquet URLs to load on add |
| `sampleUrl` | `string` | `undefined` | URL shown in the panel input without auto-loading |
| `pageSize` | `number` | `10000` | Rows loaded per query |
| `selectedColumns` | `string[]` | `null` | Attribute columns to load |
| `fitBoundsOnLoad` | `boolean` | `true` | Fit the map to loaded data |
| `allowLocalFiles` | `boolean` | `true` | Enable local file input |
| `allowRemoteUrls` | `boolean` | `true` | Enable remote URL input |
| `pickable` | `boolean` | `true` | Enable feature clicking and attribute popups |
| `layerName` | `string` | `undefined` | Initial display name for the next loaded layer |
| `beforeId` | `string` | `undefined` | Map layer id to insert deck.gl layers before |
| `interleaved` | `boolean` | `true` | Insert deck.gl layers into the MapLibre layer stack so `beforeId` can apply |

### Methods

- `loadUrl(url: string): Promise<void>`
- `loadUrls(urls: string[]): Promise<void>`
- `loadFile(file: File): Promise<void>`
- `loadFiles(files: File[]): Promise<void>`
- `clear(): void`
- `removeLayer(layerId: string): void`
- `loadMore(layerId?: string): Promise<void>`
- `reloadViewport(layerId?: string): Promise<void>`
- `setPickable(pickable: boolean): void`
- `getState(): GeoParquetState`
- `on(event, handler): void`
- `off(event, handler): void`

### Events

`collapse`, `expand`, `statechange`, `loadstart`, `progress`, `load`, `error`, and `select`.

Legacy aliases `PluginControl`, `PluginControlReact`, and `usePluginState` are exported for
template migration, but new code should use the GeoParquet names.

## Runtime requirements

The DuckDB-WASM runtime and its `parquet`, `httpfs`, and `spatial` extensions are loaded
from public CDNs at runtime (the DuckDB-WASM core from jsDelivr and the extensions from
`extensions.duckdb.org`) rather than bundled into the package. This keeps the published
package small, but means the host page needs network access to those origins the first time
a GeoParquet file is loaded.

### Self-hosting the runtime

To avoid the public CDNs (for offline use, air-gapped deployments, or stricter CSP), call
`configureDuckDB` once before the first GeoParquet file is loaded. Pass custom DuckDB-WASM
bundles, a mirrored extension repository, or both:

```ts
import { configureDuckDB } from 'maplibre-gl-geoparquet';
import * as duckdb from '@duckdb/duckdb-wasm';

configureDuckDB({
  // Serve the DuckDB-WASM core/worker from your own origin.
  bundles: {
    mvp: {
      mainModule: '/duckdb/duckdb-mvp.wasm',
      mainWorker: '/duckdb/duckdb-browser-mvp.worker.js',
    },
    eh: {
      mainModule: '/duckdb/duckdb-eh.wasm',
      mainWorker: '/duckdb/duckdb-browser-eh.worker.js',
    },
  } satisfies duckdb.DuckDBBundles,
  // Mirror of extensions.duckdb.org laid out as
  // <base>/<version>/wasm_eh/<name>.duckdb_extension.wasm
  extensionRepository: 'https://cdn.example.com/duckdb-extensions',
});
```

DuckDB is initialized lazily and cached, so `configureDuckDB` only takes effect when called
before the first load.

## Development

```bash
npm install
npm run dev
```

## Scripts

| Script | Description |
|---|---|
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
[moregeo-it/geoparquet-viewer](https://github.com/moregeo-it/geoparquet-viewer),
including its GeoParquet loading, metadata, and browser visualization workflows.
