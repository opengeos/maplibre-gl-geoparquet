import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import maplibregl, { Map } from 'maplibre-gl';
import { GeoParquetControlReact, useGeoParquetState } from '../../src/react';
import '../../src/index.css';
import 'maplibre-gl/dist/maplibre-gl.css';

const sampleUrl =
  'https://raw.githubusercontent.com/opengeospatial/geoparquet/main/examples/example.parquet';

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);
  const { state, setState } = useGeoParquetState({ collapsed: false });

  useEffect(() => {
    if (!mapContainer.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://demotiles.maplibre.org/style.json',
      center: [0, 0],
      zoom: 2,
    });

    mapInstance.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapInstance.on('load', () => setMap(mapInstance));

    return () => {
      mapInstance.remove();
    };
  }, []);

  return (
    <div className="example-shell">
      <div ref={mapContainer} className="example-map" />
      <div className="example-status">
        {state.loading
          ? state.statusMessage || 'Loading...'
          : state.loadedRows > 0
            ? `${state.loadedRows.toLocaleString()} rows loaded`
            : 'No rows loaded'}
      </div>
      {map && (
        <GeoParquetControlReact
          map={map}
          title="GeoParquet"
          collapsed={state.collapsed}
          panelWidth={360}
          sourceUrl={sampleUrl}
          onStateChange={setState}
          onError={(error) => console.error(error)}
        />
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
