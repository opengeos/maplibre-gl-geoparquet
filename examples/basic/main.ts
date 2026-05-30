import maplibregl from 'maplibre-gl';
import { GeoParquetControl } from '../../src/index';
import '../../src/index.css';
import 'maplibre-gl/dist/maplibre-gl.css';

const sampleUrl =
  'https://raw.githubusercontent.com/opengeospatial/geoparquet/main/examples/example.parquet';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [0, 0],
  zoom: 2,
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');

map.on('load', () => {
  const control = new GeoParquetControl({
    title: 'GeoParquet',
    collapsed: false,
    panelWidth: 360,
    sampleUrl,
  });

  control.on('load', (event) => {
    console.log('GeoParquet loaded:', event.state);
  });
  control.on('error', (event) => {
    console.error('GeoParquet error:', event.error);
  });
  control.on('select', (event) => {
    console.log('Selected feature:', event.selection);
  });

  map.addControl(control, 'top-right');
});
