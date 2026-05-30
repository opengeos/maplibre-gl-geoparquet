import { useEffect, useRef } from 'react';
import { GeoParquetControl } from './GeoParquetControl';
import type { GeoParquetControlReactProps } from './types';

export function GeoParquetControlReact({
  map,
  onStateChange,
  onLoad,
  onError,
  onSelect,
  ...options
}: GeoParquetControlReactProps): null {
  const controlRef = useRef<GeoParquetControl | null>(null);

  useEffect(() => {
    if (!map) return;

    const control = new GeoParquetControl(options);
    controlRef.current = control;

    if (onStateChange) {
      control.on('statechange', (event) => onStateChange(event.state));
    }
    if (onLoad) {
      control.on('load', (event) => onLoad(event.state));
    }
    if (onError) {
      control.on('error', (event) => onError(event.error ?? new Error('GeoParquet load failed'), event.state));
    }
    if (onSelect) {
      control.on('select', (event) => onSelect(event.selection ?? null, event.state));
    }

    map.addControl(control, options.position || 'top-right');

    return () => {
      if (map.hasControl(control)) {
        map.removeControl(control);
      }
      controlRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    const control = controlRef.current;
    if (!control || options.collapsed === undefined) return;
    if (options.collapsed) control.collapse();
    else control.expand();
  }, [options.collapsed]);

  useEffect(() => {
    const control = controlRef.current;
    if (!control || !options.sourceUrl) return;
    control.loadUrl(options.sourceUrl).catch(() => {});
  }, [options.sourceUrl]);

  return null;
}

export const PluginControlReact = GeoParquetControlReact;
