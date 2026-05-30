import maplibregl, { type IControl, type Map as MapLibreMap } from 'maplibre-gl';
import { buildGeoArrowTables, resolveCloudUrl, toBinary, type GeoArrowResult } from '@walkthru-earth/objex-utils';
import {
  bootstrapMetadata,
  dropFile,
  initDB,
  queryCount,
  queryData,
  registerLocalFile,
} from '../geoparquet/duckdb';
import { checkFileHealth, type FileHealthWarning } from '../geoparquet/fileHealth';
import { DEFAULT_PAGE_SIZE, DEFAULT_PANEL_WIDTH, DEFAULT_TITLE } from '../geoparquet/constants';
import {
  GeoParquetRenderer,
  type GeoParquetPickInfo,
} from '../geoparquet/renderer';
import {
  detectPrimaryGeoColumn,
  formatDisplayValue,
  friendlyError,
  getBboxCovering,
  getDisplayColumns,
  getKnownGeometryType,
  getSourceCrsString,
  needsReprojection,
  normalizeBinary,
} from '../geoparquet/utils';
import type {
  GeoParquetColumn,
  GeoParquetControlEvent,
  GeoParquetControlEventData,
  GeoParquetControlEventHandler,
  GeoParquetControlOptions,
  GeoParquetFeatureSelection,
  GeoParquetGeoMetadata,
  GeoParquetLayerState,
  GeoParquetMetadata,
  GeoParquetState,
} from './types';

const DEFAULT_OPTIONS: Required<
    Omit<
      GeoParquetControlOptions,
      'sourceUrl' | 'sourceUrls' | 'sampleUrl' | 'selectedColumns' | 'layerName' | 'beforeId'
    >
> = {
  collapsed: true,
  position: 'top-right',
  title: DEFAULT_TITLE,
  panelWidth: DEFAULT_PANEL_WIDTH,
  className: '',
  pageSize: DEFAULT_PAGE_SIZE,
  fitBoundsOnLoad: true,
  allowLocalFiles: true,
  allowRemoteUrls: true,
  pickable: true,
  interleaved: true,
};

type EventHandlersMap = globalThis.Map<GeoParquetControlEvent, Set<GeoParquetControlEventHandler>>;

interface LoadedGeoParquetLayer {
  id: string;
  name: string;
  beforeId: string | null;
  source: string;
  displaySource: string;
  localFileName: string | null;
  schema: GeoParquetColumn[];
  geoMetadata: GeoParquetGeoMetadata | null;
  metadata: GeoParquetMetadata | null;
  selectedColumns: string[] | null;
  pageSize: number;
  totalRows: number;
  filteredCount: number | null;
  currentOffset: number;
  lastPageFull: boolean;
  primaryGeoColumn: string | null;
  geoColumns: string[];
  geoArrowResults: GeoArrowResult[];
  rows: Record<number, Record<string, unknown>>;
  currentViewportBbox: [number, number, number, number] | null;
  warnings: FileHealthWarning[];
}

export class GeoParquetControl implements IControl {
  private map?: MapLibreMap;
  private mapContainer?: HTMLElement;
  private container?: HTMLElement;
  private panel?: HTMLElement;
  private content?: HTMLElement;
  private renderer?: GeoParquetRenderer;
  private popup: maplibregl.Popup | null = null;
  private options: Required<
    Omit<
      GeoParquetControlOptions,
      'sourceUrl' | 'sourceUrls' | 'sampleUrl' | 'selectedColumns' | 'layerName' | 'beforeId'
    >
  > &
    Pick<
      GeoParquetControlOptions,
      'sourceUrl' | 'sourceUrls' | 'sampleUrl' | 'selectedColumns' | 'layerName' | 'beforeId'
    >;
  private eventHandlers: EventHandlersMap = new globalThis.Map();
  private resizeHandler: (() => void) | null = null;
  private mapResizeHandler: (() => void) | null = null;
  private clickOutsideHandler: ((event: MouseEvent) => void) | null = null;

  private collapsed: boolean;
  private layers: LoadedGeoParquetLayer[] = [];
  private activeLayerId: string | null = null;
  private loading = false;
  private statusMessage = '';
  private error: string | null = null;
  private selectedFeature: GeoParquetFeatureSelection | null = null;
  private pickable: boolean;
  private nextLayerName = '';
  private nextBeforeId = '';

  constructor(options?: Partial<GeoParquetControlOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.collapsed = this.options.collapsed;
    this.pickable = this.options.pickable;
    this.nextLayerName = this.options.layerName ?? '';
    this.nextBeforeId = this.options.beforeId ?? '';
  }

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    this.mapContainer = map.getContainer();
    this.container = this.createContainer();
    this.panel = this.createPanel();
    this.content = this.panel.querySelector('.geoparquet-control-content') as HTMLElement;
    this.mapContainer.appendChild(this.panel);
    this.renderer = new GeoParquetRenderer(map, {
      onSelect: (selection) => this.handleMapSelect(selection),
      interleaved: this.options.interleaved,
    });
    this.renderer.setPickable(this.pickable);
    this.setupEventListeners();

    if (!this.collapsed) {
      this.panel.classList.add('expanded');
      requestAnimationFrame(() => this.updatePanelPosition());
    }
    this.renderContent();

    const initialUrls = [
      ...(this.options.sourceUrls ?? []),
      ...(this.options.sourceUrl ? [this.options.sourceUrl] : []),
    ];
    if (initialUrls.length > 0) {
      this.loadUrls(initialUrls).catch(() => {
        // loadUrls renders and emits errors.
      });
    }

    return this.container;
  }

  onRemove(): void {
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    if (this.mapResizeHandler && this.map) this.map.off('resize', this.mapResizeHandler);
    if (this.clickOutsideHandler) document.removeEventListener('click', this.clickOutsideHandler);

    this.popup?.remove();
    this.renderer?.remove();
    this.panel?.parentNode?.removeChild(this.panel);
    this.container?.parentNode?.removeChild(this.container);
    this.layers.forEach((layer) => {
      if (layer.localFileName) dropFile(layer.localFileName).catch(() => {});
    });

    this.map = undefined;
    this.mapContainer = undefined;
    this.container = undefined;
    this.panel = undefined;
    this.content = undefined;
    this.renderer = undefined;
    this.eventHandlers.clear();
  }

  getState(): GeoParquetState {
    const activeLayer = this.getActiveLayer();
    return {
      collapsed: this.collapsed,
      panelWidth: this.options.panelWidth,
      source: activeLayer?.source ?? null,
      displaySource: activeLayer?.displaySource ?? '',
      layers: this.layers.map((layer) => this.toLayerState(layer)),
      activeLayerId: this.activeLayerId,
      loading: this.loading,
      statusMessage: this.statusMessage,
      error: this.error,
      schema: activeLayer ? [...activeLayer.schema] : [],
      selectedColumns: activeLayer?.selectedColumns ? [...activeLayer.selectedColumns] : null,
      pageSize: activeLayer?.pageSize ?? this.options.pageSize,
      totalRows: activeLayer?.totalRows ?? -1,
      loadedRows: activeLayer ? Object.keys(activeLayer.rows).length : 0,
      hasMore: activeLayer ? this.layerHasMore(activeLayer) : false,
      primaryGeoColumn: activeLayer?.primaryGeoColumn ?? null,
      selectedFeature: this.selectedFeature,
      metadata: activeLayer?.metadata ?? null,
      pickable: this.pickable,
    };
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
    if (this.panel) {
      if (this.collapsed) {
        this.panel.classList.remove('expanded');
        this.emit('collapse');
      } else {
        this.panel.classList.add('expanded');
        this.updatePanelPosition();
        this.emit('expand');
      }
    }
    this.emit('statechange');
  }

  expand(): void {
    if (this.collapsed) this.toggle();
  }

  collapse(): void {
    if (!this.collapsed) this.toggle();
  }

  on(event: GeoParquetControlEvent, handler: GeoParquetControlEventHandler): void {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: GeoParquetControlEvent, handler: GeoParquetControlEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  getMap(): MapLibreMap | undefined {
    return this.map;
  }

  getContainer(): HTMLElement | undefined {
    return this.container;
  }

  setPickable(pickable: boolean): void {
    this.pickable = pickable;
    this.renderer?.setPickable(pickable);
    if (!pickable) {
      this.selectedFeature = null;
      this.popup?.remove();
      this.popup = null;
      this.renderer?.setSelectedFeature(null, null);
    }
    this.renderAllLayers();
    this.renderContent();
    this.emit('statechange');
  }

  async loadUrl(url: string): Promise<void> {
    await this.loadUrls([url]);
  }

  async loadUrls(urls: string[]): Promise<void> {
    if (!this.options.allowRemoteUrls) {
      throw new Error('Remote URL loading is disabled for this GeoParquet control');
    }
    const normalizedUrls = urls.map((url) => url.trim()).filter(Boolean);
    for (const url of normalizedUrls) {
      const resolvedUrl = resolveCloudUrl(url);
      this.emit('loadstart');
      this.setLoading(`Checking ${this.displayNameFromSource(resolvedUrl)}...`);
      const warnings = await checkFileHealth(resolvedUrl);
      await this.loadSource({
        source: resolvedUrl,
        displaySource: resolvedUrl,
        localFileName: null,
        layerName: this.consumeLayerName(resolvedUrl),
        beforeId: this.nextBeforeId.trim() || null,
        warnings,
      });
    }
  }

  async loadFile(file: File): Promise<void> {
    await this.loadFiles([file]);
  }

  async loadFiles(files: File[]): Promise<void> {
    if (!this.options.allowLocalFiles) {
      throw new Error('Local file loading is disabled for this GeoParquet control');
    }
    for (const file of files) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const fileName = `local_${Date.now()}_${Math.random().toString(36).slice(2)}_${safeName}`;
      this.emit('loadstart');
      this.setLoading(`Reading ${file.name}...`);
      try {
        const buffer = await file.arrayBuffer();
        await initDB((message) => this.setProgress(message));
        await registerLocalFile(fileName, buffer);
        await this.loadSource({
          source: fileName,
          displaySource: file.name,
          localFileName: fileName,
          layerName: this.consumeLayerName(file.name),
          beforeId: this.nextBeforeId.trim() || null,
          warnings: [],
        });
      } catch (error) {
        this.handleError(error);
        throw error;
      }
    }
  }

  clear(): void {
    this.layers.forEach((layer) => {
      if (layer.localFileName) dropFile(layer.localFileName).catch(() => {});
    });
    this.layers = [];
    this.activeLayerId = null;
    this.loading = false;
    this.statusMessage = '';
    this.error = null;
    this.selectedFeature = null;
    this.popup?.remove();
    this.popup = null;
    this.renderer?.clear();
    this.renderContent();
    this.emit('statechange');
  }

  removeLayer(layerId: string): void {
    const layer = this.layers.find((item) => item.id === layerId);
    if (!layer) return;
    if (layer.localFileName) dropFile(layer.localFileName).catch(() => {});
    this.layers = this.layers.filter((item) => item.id !== layerId);
    if (this.activeLayerId === layerId) {
      this.activeLayerId = this.layers.length ? this.layers[this.layers.length - 1].id : null;
    }
    if (this.selectedFeature?.layerId === layerId) {
      this.selectedFeature = null;
      this.popup?.remove();
      this.popup = null;
    }
    this.renderAllLayers();
    this.renderContent();
    this.emit('statechange');
  }

  async loadMore(layerId = this.activeLayerId): Promise<void> {
    const layer = this.getLayer(layerId);
    if (!layer || this.loading || !this.layerHasMore(layer)) return;
    await this.runTask('Loading more rows...', async () => {
      await this.executeQuery(layer, layer.currentOffset, layer.pageSize, layer.currentViewportBbox);
    });
  }

  async reloadViewport(layerId = this.activeLayerId): Promise<void> {
    const layer = this.getLayer(layerId);
    if (!this.map || !layer || !getBboxCovering(layer.geoMetadata, layer.primaryGeoColumn)) return;
    const bounds = this.map.getBounds();
    layer.currentViewportBbox = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ];
    this.clearLayerData(layer);

    await this.runTask('Loading current viewport...', async () => {
      layer.filteredCount = await queryCount(
        layer.source,
        [],
        layer.currentViewportBbox,
        layer.primaryGeoColumn,
        getSourceCrsString(layer.geoMetadata, layer.primaryGeoColumn),
        getBboxCovering(layer.geoMetadata, layer.primaryGeoColumn)
      );
      await this.executeQuery(layer, 0, layer.pageSize, layer.currentViewportBbox);
    });
  }

  private async loadSource({
    source,
    displaySource,
    localFileName,
    layerName,
    beforeId,
    warnings,
  }: {
    source: string;
    displaySource: string;
    localFileName: string | null;
    layerName: string;
    beforeId: string | null;
    warnings: FileHealthWarning[];
  }): Promise<void> {
    try {
      await initDB((message) => this.setProgress(message));
      this.setProgress(`Reading ${this.displayNameFromSource(displaySource)} metadata...`);
      const metadata = await bootstrapMetadata(source, (message) => this.setProgress(message));
      const primaryGeoColumn = detectPrimaryGeoColumn(metadata.schema, metadata.geoMetadata);
      const geoColumns = metadata.geoMetadata?.columns
        ? Object.keys(metadata.geoMetadata.columns)
        : primaryGeoColumn
          ? [primaryGeoColumn]
          : [];
      const layer: LoadedGeoParquetLayer = {
        id: this.createLayerId(),
        name: layerName,
        beforeId,
        source,
        displaySource,
        localFileName,
        schema: metadata.schema,
        geoMetadata: metadata.geoMetadata,
        metadata,
        selectedColumns: this.options.selectedColumns ? [...this.options.selectedColumns] : null,
        pageSize: this.options.pageSize,
        totalRows: metadata.totalRows,
        filteredCount: null,
        currentOffset: 0,
        lastPageFull: false,
        primaryGeoColumn,
        geoColumns,
        geoArrowResults: [],
        rows: {},
        currentViewportBbox: null,
        warnings,
      };
      this.layers.push(layer);
      this.activeLayerId = layer.id;
      await this.executeQuery(layer, 0, layer.pageSize, null);
      this.loading = false;
      this.statusMessage = '';
      this.error = null;
      this.renderContent();
      this.emit('load');
      this.emit('statechange');
    } catch (error) {
      if (localFileName) dropFile(localFileName).catch(() => {});
      this.handleError(error);
      throw error;
    }
  }

  private async runTask(message: string, task: () => Promise<void>): Promise<void> {
    try {
      this.setLoading(message);
      await task();
      this.loading = false;
      this.statusMessage = '';
      this.renderContent();
      this.emit('statechange');
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  private async executeQuery(
    layer: LoadedGeoParquetLayer,
    offset = 0,
    limit: number | null = layer.pageSize,
    bbox: [number, number, number, number] | null = null
  ): Promise<void> {
    const displayColumns = getDisplayColumns(layer.schema, layer.geoColumns, layer.selectedColumns);
    const displayColumnNames = displayColumns.map((column) => column.name);
    const geoColumn = layer.primaryGeoColumn;
    const selectedQueryColumns = geoColumn ? [...displayColumnNames, geoColumn] : displayColumnNames;
    if (selectedQueryColumns.length === 0) return;

    const result = await queryData(layer.source, {
      geoColumn,
      bbox,
      sourceCrs: getSourceCrsString(layer.geoMetadata, layer.primaryGeoColumn),
      columns: selectedQueryColumns,
      bboxCovering: getBboxCovering(layer.geoMetadata, layer.primaryGeoColumn),
      limit,
      offset,
    });

    const displayVectors = displayColumnNames.map((name) => ({
      name,
      vector: result.getChild(name),
    }));
    const wkbFromSpatial = result.getChild('__wkb');
    const rawWkbVector = geoColumn ? result.getChild(geoColumn) : null;
    const mapWkbs: Uint8Array[] = [];
    const mapIndices: number[] = [];

    for (let rowIndex = 0; rowIndex < result.numRows; rowIndex += 1) {
      const globalIndex = offset + rowIndex;
      const row: Record<string, unknown> = { __index: globalIndex, __layer: layer.displaySource };
      displayVectors.forEach(({ name, vector }) => {
        row[name] = vector ? formatDisplayValue(vector.get(rowIndex)) : null;
      });
      layer.rows[globalIndex] = row;

      const rawWkb = wkbFromSpatial?.get(rowIndex) ?? rawWkbVector?.get(rowIndex);
      const wkb = wkbFromSpatial ? normalizeBinary(rawWkb) : toBinary(rawWkb);
      if (wkb) {
        mapWkbs.push(wkb);
        mapIndices.push(globalIndex);
      }
    }

    if (mapWkbs.length > 0) {
      const attributes = new globalThis.Map([['__index', { values: mapIndices, type: 'BIGINT' }]]);
      const geoArrowResults = buildGeoArrowTables(
        mapWkbs,
        attributes,
        getKnownGeometryType(layer.geoMetadata, layer.primaryGeoColumn)
      );
      layer.geoArrowResults = layer.geoArrowResults.concat(geoArrowResults);
      this.renderAllLayers();
      if (offset === 0 && this.options.fitBoundsOnLoad) {
        this.fitToData(layer, geoArrowResults);
      }
    }

    layer.currentOffset = offset + result.numRows;
    layer.lastPageFull = limit !== null ? result.numRows >= limit : false;
    this.renderContent();
  }

  private fitToData(layer: LoadedGeoParquetLayer, results: GeoArrowResult[]): void {
    if (!this.map) return;
    let bounds = layer.geoMetadata?.columns?.[layer.primaryGeoColumn ?? '']?.bbox;
    if (bounds && needsReprojection(layer.geoMetadata, layer.primaryGeoColumn)) {
      bounds = undefined;
    }
    if (!bounds && results.length) {
      const minX = Math.min(...results.map((result) => result.bounds[0]));
      const minY = Math.min(...results.map((result) => result.bounds[1]));
      const maxX = Math.max(...results.map((result) => result.bounds[2]));
      const maxY = Math.max(...results.map((result) => result.bounds[3]));
      bounds = [minX, minY, maxX, maxY];
    }
    if (!bounds || bounds.some((value) => !Number.isFinite(value))) return;
    const [west, south, east, north] = bounds;
    if (Math.abs(west) > 180 || Math.abs(east) > 180 || Math.abs(south) > 90 || Math.abs(north) > 90) {
      return;
    }
    if (Math.abs(east - west) < 1e-9 && Math.abs(north - south) < 1e-9) {
      this.map.flyTo({ center: [west, south], zoom: Math.max(this.map.getZoom(), 12), duration: 500 });
    } else {
      this.map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 60, maxZoom: 15, duration: 500 }
      );
    }
  }

  private handleMapSelect(selection: GeoParquetPickInfo | null): void {
    if (!this.pickable || !selection) {
      this.selectedFeature = null;
      this.popup?.remove();
      this.popup = null;
      this.renderer?.setSelectedFeature(null, null);
      this.renderContent();
      this.emit('select', { selection: null });
      this.emit('statechange');
      return;
    }

    const layer = this.getLayer(selection.layerId);
    if (!layer) return;
    this.activeLayerId = layer.id;
    this.selectedFeature = {
      layerId: layer.id,
      layerName: layer.name,
      index: selection.index,
      properties: layer.rows[selection.index] ?? { __index: selection.index },
    };
    this.renderer?.setSelectedFeature(layer.id, selection.index);
    this.renderAllLayers();
    this.showAttributePopup(selection.coordinate);
    this.renderContent();
    this.emit('select', { selection: this.selectedFeature });
    this.emit('statechange');
  }

  private showAttributePopup(coordinate: [number, number] | null): void {
    if (!this.map || !this.selectedFeature || !coordinate) return;
    const rows = Object.entries(this.selectedFeature.properties)
      .filter(([key]) => !key.startsWith('__'))
      .slice(0, 8)
      .map(([key, value]) => `<tr><th>${this.escapeHtml(key)}</th><td>${this.escapeHtml(String(value ?? ''))}</td></tr>`)
      .join('');
    this.popup?.remove();
    this.popup = new maplibregl.Popup({
      className: 'geoparquet-attribute-popup',
      closeButton: true,
      closeOnClick: false,
      maxWidth: '320px',
    })
      .setLngLat(coordinate)
      .setHTML(
        `<div class="geoparquet-popup"><strong>${this.escapeHtml(
          this.selectedFeature.layerName
        )}</strong><table>${rows}</table></div>`
      )
      .addTo(this.map);
  }

  private clearLayerData(layer: LoadedGeoParquetLayer): void {
    layer.rows = {};
    layer.geoArrowResults = [];
    layer.currentOffset = 0;
    layer.lastPageFull = false;
    if (this.selectedFeature?.layerId === layer.id) {
      this.selectedFeature = null;
      this.popup?.remove();
      this.popup = null;
    }
    this.renderAllLayers();
  }

  private renderAllLayers(): void {
    this.renderer?.setPickable(this.pickable);
    this.renderer?.setSelectedFeature(this.selectedFeature?.layerId ?? null, this.selectedFeature?.index ?? null);
    this.renderer?.setData(
      this.layers.map((layer) => ({
        id: layer.id,
        name: layer.name,
        beforeId: layer.beforeId,
        results: layer.geoArrowResults,
      }))
    );
  }

  private getActiveLayer(): LoadedGeoParquetLayer | null {
    return this.getLayer(this.activeLayerId);
  }

  private getLayer(layerId: string | null | undefined): LoadedGeoParquetLayer | null {
    if (!layerId) return null;
    return this.layers.find((layer) => layer.id === layerId) ?? null;
  }

  private layerHasMore(layer: LoadedGeoParquetLayer): boolean {
    const loadedRows = Object.keys(layer.rows).length;
    const activeTotal = layer.filteredCount ?? layer.totalRows;
    return activeTotal < 0 ? layer.lastPageFull : loadedRows < activeTotal;
  }

  private toLayerState(layer: LoadedGeoParquetLayer): GeoParquetLayerState {
    return {
      id: layer.id,
      name: layer.name,
      beforeId: layer.beforeId,
      source: layer.source,
      displaySource: layer.displaySource,
      schema: [...layer.schema],
      selectedColumns: layer.selectedColumns ? [...layer.selectedColumns] : null,
      pageSize: layer.pageSize,
      totalRows: layer.totalRows,
      loadedRows: Object.keys(layer.rows).length,
      hasMore: this.layerHasMore(layer),
      primaryGeoColumn: layer.primaryGeoColumn,
      metadata: layer.metadata,
    };
  }

  private setLoading(message: string): void {
    this.loading = true;
    this.statusMessage = message;
    this.error = null;
    this.renderContent();
    this.emit('progress');
    this.emit('statechange');
  }

  private setProgress(message: string): void {
    this.statusMessage = message;
    this.renderContent();
    this.emit('progress');
    this.emit('statechange');
  }

  private handleError(error: unknown): void {
    const info = friendlyError(error);
    const actualError = error instanceof Error ? error : new Error(String(error));
    this.loading = false;
    this.statusMessage = '';
    this.error = [info.detail, info.suggestion].filter(Boolean).join(' ');
    this.renderContent();
    this.emit('error', { error: actualError });
    this.emit('statechange');
  }

  private emit(event: GeoParquetControlEvent, extra: Partial<GeoParquetControlEventData> = {}): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    const eventData: GeoParquetControlEventData = {
      type: event,
      state: this.getState(),
      ...extra,
    };
    handlers.forEach((handler) => handler(eventData));
  }

  private createContainer(): HTMLElement {
    const container = document.createElement('div');
    container.className = `maplibregl-ctrl maplibregl-ctrl-group geoparquet-control${
      this.options.className ? ` ${this.options.className}` : ''
    }`;

    const toggleButton = document.createElement('button');
    toggleButton.className = 'geoparquet-control-toggle';
    toggleButton.type = 'button';
    toggleButton.setAttribute('aria-label', this.options.title);
    toggleButton.innerHTML = `
      <span class="geoparquet-control-icon">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5h16"/>
          <path d="M4 12h16"/>
          <path d="M4 19h16"/>
          <path d="M7 3v18"/>
          <path d="M17 3v18"/>
        </svg>
      </span>
    `;
    toggleButton.addEventListener('click', () => this.toggle());
    container.appendChild(toggleButton);
    return container;
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'geoparquet-control-panel';
    panel.style.width = `${this.options.panelWidth}px`;

    const header = document.createElement('div');
    header.className = 'geoparquet-control-header';

    const title = document.createElement('span');
    title.className = 'geoparquet-control-title';
    title.textContent = this.options.title;

    const closeButton = document.createElement('button');
    closeButton.className = 'geoparquet-control-close';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close panel');
    closeButton.innerHTML = '&times;';
    closeButton.addEventListener('click', () => this.collapse());

    const content = document.createElement('div');
    content.className = 'geoparquet-control-content';

    header.appendChild(title);
    header.appendChild(closeButton);
    panel.appendChild(header);
    panel.appendChild(content);
    return panel;
  }

  private setupEventListeners(): void {
    this.clickOutsideHandler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (this.container && this.panel && !this.container.contains(target) && !this.panel.contains(target)) {
        this.collapse();
      }
    };
    document.addEventListener('click', this.clickOutsideHandler);

    this.resizeHandler = () => {
      if (!this.collapsed) this.updatePanelPosition();
    };
    window.addEventListener('resize', this.resizeHandler);

    this.mapResizeHandler = () => {
      if (!this.collapsed) this.updatePanelPosition();
    };
    this.map?.on('resize', this.mapResizeHandler);
  }

  private getControlPosition(): 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' {
    const parent = this.container?.parentElement;
    if (!parent) return 'top-right';
    if (parent.classList.contains('maplibregl-ctrl-top-left')) return 'top-left';
    if (parent.classList.contains('maplibregl-ctrl-top-right')) return 'top-right';
    if (parent.classList.contains('maplibregl-ctrl-bottom-left')) return 'bottom-left';
    if (parent.classList.contains('maplibregl-ctrl-bottom-right')) return 'bottom-right';
    return 'top-right';
  }

  private updatePanelPosition(): void {
    if (!this.container || !this.panel || !this.mapContainer) return;
    const button = this.container.querySelector('.geoparquet-control-toggle');
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const mapRect = this.mapContainer.getBoundingClientRect();
    const position = this.getControlPosition();
    const top = buttonRect.top - mapRect.top;
    const bottom = mapRect.bottom - buttonRect.bottom;
    const left = buttonRect.left - mapRect.left;
    const right = mapRect.right - buttonRect.right;
    const gap = 5;

    this.panel.style.top = '';
    this.panel.style.bottom = '';
    this.panel.style.left = '';
    this.panel.style.right = '';

    if (position === 'top-left') {
      this.panel.style.top = `${top + buttonRect.height + gap}px`;
      this.panel.style.left = `${left}px`;
    } else if (position === 'top-right') {
      this.panel.style.top = `${top + buttonRect.height + gap}px`;
      this.panel.style.right = `${right}px`;
    } else if (position === 'bottom-left') {
      this.panel.style.bottom = `${bottom + buttonRect.height + gap}px`;
      this.panel.style.left = `${left}px`;
    } else {
      this.panel.style.bottom = `${bottom + buttonRect.height + gap}px`;
      this.panel.style.right = `${right}px`;
    }
  }

  private renderContent(): void {
    if (!this.content) return;
    this.content.replaceChildren();
    const activeLayer = this.getActiveLayer();

    const fragment = document.createDocumentFragment();
    fragment.appendChild(this.renderLoadSection());
    fragment.appendChild(this.renderStatusSection(activeLayer));
    if (this.layers.length > 0) {
      fragment.appendChild(this.renderLayerSection());
    }
    if (activeLayer) {
      fragment.appendChild(this.renderMetadataSection(activeLayer));
      fragment.appendChild(this.renderColumnSection(activeLayer));
      fragment.appendChild(this.renderActionSection(activeLayer));
    }
    if (this.selectedFeature) {
      fragment.appendChild(this.renderSelectionSection());
    }
    this.content.appendChild(fragment);
  }

  private renderLoadSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'geoparquet-control-section';

    if (this.options.allowRemoteUrls) {
      const label = document.createElement('label');
      label.className = 'geoparquet-control-label';
      label.textContent = 'GeoParquet URL(s)';
      const row = document.createElement('div');
      row.className = 'geoparquet-control-row';
      const input = document.createElement('input');
      input.className = 'geoparquet-control-input';
      input.type = 'text';
      input.placeholder = 'Paste one or more URLs';
      input.value = this.options.sampleUrl ?? '';
      const button = document.createElement('button');
      button.className = 'geoparquet-control-button';
      button.type = 'button';
      button.textContent = 'Add';
      button.disabled = this.loading;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const urls = this.parseUrlList(input.value);
        if (urls.length > 0) {
          this.loadUrls(urls).catch(() => {});
          input.value = '';
        }
      });
      row.appendChild(input);
      row.appendChild(button);
      section.appendChild(label);
      section.appendChild(row);
    }

    const layerFields = document.createElement('div');
    layerFields.className = 'geoparquet-control-grid';
    const nameLabel = document.createElement('label');
    nameLabel.className = 'geoparquet-control-label';
    nameLabel.textContent = 'Layer name';
    const nameInput = document.createElement('input');
    nameInput.className = 'geoparquet-control-input';
    nameInput.type = 'text';
    nameInput.placeholder = 'Auto';
    nameInput.value = this.nextLayerName;
    nameInput.addEventListener('input', () => {
      this.nextLayerName = nameInput.value;
    });
    const beforeLabel = document.createElement('label');
    beforeLabel.className = 'geoparquet-control-label';
    beforeLabel.textContent = 'before_id';
    const beforeInput = document.createElement('input');
    beforeInput.className = 'geoparquet-control-input';
    beforeInput.type = 'text';
    beforeInput.placeholder = 'Map layer id';
    beforeInput.value = this.nextBeforeId;
    beforeInput.addEventListener('input', () => {
      this.nextBeforeId = beforeInput.value;
    });
    nameLabel.appendChild(nameInput);
    beforeLabel.appendChild(beforeInput);
    layerFields.appendChild(nameLabel);
    layerFields.appendChild(beforeLabel);
    section.appendChild(layerFields);

    if (this.options.allowLocalFiles) {
      const fileInput = document.createElement('input');
      fileInput.className = 'geoparquet-control-file';
      fileInput.type = 'file';
      fileInput.accept = '.parquet,.geoparquet,application/octet-stream';
      fileInput.multiple = true;
      fileInput.disabled = this.loading;
      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files ?? []);
        if (files.length > 0) this.loadFiles(files).catch(() => {});
      });
      section.appendChild(fileInput);
    }

    const pickableLabel = document.createElement('label');
    pickableLabel.className = 'geoparquet-control-check';
    const pickableInput = document.createElement('input');
    pickableInput.type = 'checkbox';
    pickableInput.checked = this.pickable;
    pickableInput.addEventListener('change', () => this.setPickable(pickableInput.checked));
    const pickableText = document.createElement('span');
    pickableText.textContent = 'Show attribute popup on feature click';
    pickableLabel.appendChild(pickableInput);
    pickableLabel.appendChild(pickableText);
    section.appendChild(pickableLabel);

    if (this.layers.length > 0) {
      const clearButton = document.createElement('button');
      clearButton.className = 'geoparquet-control-secondary-button';
      clearButton.type = 'button';
      clearButton.textContent = 'Clear all';
      clearButton.disabled = this.loading;
      clearButton.addEventListener('click', () => this.clear());
      section.appendChild(clearButton);
    }

    return section;
  }

  private renderStatusSection(activeLayer: LoadedGeoParquetLayer | null): HTMLElement {
    const section = document.createElement('div');
    section.className = 'geoparquet-control-section';
    if (this.statusMessage) {
      const status = document.createElement('div');
      status.className = 'geoparquet-control-status';
      status.textContent = this.statusMessage;
      section.appendChild(status);
    }
    if (this.error) {
      const error = document.createElement('div');
      error.className = 'geoparquet-control-error';
      error.textContent = this.error;
      section.appendChild(error);
    }
    activeLayer?.warnings.forEach((warning) => {
      const warningElement = document.createElement('div');
      warningElement.className = 'geoparquet-control-warning';
      warningElement.textContent = `${warning.title}: ${warning.detail}`;
      section.appendChild(warningElement);
    });
    if (!section.childElementCount) {
      const placeholder = document.createElement('p');
      placeholder.className = 'geoparquet-control-placeholder';
      placeholder.textContent =
        this.layers.length === 0
          ? 'Load one or more GeoParquet files to render them on the map.'
          : 'Select a layer to inspect settings and attributes.';
      section.appendChild(placeholder);
    }
    return section;
  }

  private renderLayerSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'geoparquet-control-section';
    const title = document.createElement('div');
    title.className = 'geoparquet-control-section-title';
    title.textContent = 'Loaded layers';
    section.appendChild(title);

    const list = document.createElement('div');
    list.className = 'geoparquet-control-layer-list';
    this.layers.forEach((layer) => {
      const row = document.createElement('div');
      row.className = 'geoparquet-control-layer-row';
      const label = document.createElement('label');
      label.className = 'geoparquet-control-check';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'geoparquet-active-layer';
      radio.checked = layer.id === this.activeLayerId;
      radio.addEventListener('change', () => {
        this.activeLayerId = layer.id;
        this.renderContent();
        this.emit('statechange');
      });
      const text = document.createElement('span');
      text.textContent = layer.name;
      label.appendChild(radio);
      label.appendChild(text);

      const remove = document.createElement('button');
      remove.className = 'geoparquet-control-mini-button';
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.disabled = this.loading;
      remove.addEventListener('click', () => this.removeLayer(layer.id));

      row.appendChild(label);
      row.appendChild(remove);
      list.appendChild(row);
    });
    section.appendChild(list);
    return section;
  }

  private renderMetadataSection(layer: LoadedGeoParquetLayer): HTMLElement {
    const section = document.createElement('div');
    section.className = 'geoparquet-control-section geoparquet-control-summary';
    const items: [string, string][] = [
      ['Layer', layer.name],
      ['Source', layer.displaySource],
      ['before_id', layer.beforeId ?? ''],
      ['Rows', layer.totalRows >= 0 ? layer.totalRows.toLocaleString() : 'Unknown'],
      ['Loaded', Object.keys(layer.rows).length.toLocaleString()],
      ['Geometry', layer.primaryGeoColumn ?? 'Not detected'],
    ];
    items.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'geoparquet-control-summary-row';
      const key = document.createElement('span');
      key.textContent = label;
      const val = document.createElement('strong');
      val.textContent = value;
      row.appendChild(key);
      row.appendChild(val);
      section.appendChild(row);
    });
    const controls = document.createElement('div');
    controls.className = 'geoparquet-control-grid';
    const nameLabel = document.createElement('label');
    nameLabel.className = 'geoparquet-control-label';
    nameLabel.textContent = 'Layer name';
    const nameInput = document.createElement('input');
    nameInput.className = 'geoparquet-control-input';
    nameInput.type = 'text';
    nameInput.value = layer.name;
    nameInput.disabled = this.loading;
    nameInput.addEventListener('change', () => {
      layer.name = nameInput.value.trim() || this.displayNameFromSource(layer.displaySource);
      if (this.selectedFeature?.layerId === layer.id) {
        this.selectedFeature.layerName = layer.name;
      }
      this.renderContent();
      this.emit('statechange');
    });
    const beforeLabel = document.createElement('label');
    beforeLabel.className = 'geoparquet-control-label';
    beforeLabel.textContent = 'before_id';
    const beforeInput = document.createElement('input');
    beforeInput.className = 'geoparquet-control-input';
    beforeInput.type = 'text';
    beforeInput.placeholder = 'Map layer id';
    beforeInput.value = layer.beforeId ?? '';
    beforeInput.disabled = this.loading;
    beforeInput.addEventListener('change', () => {
      layer.beforeId = beforeInput.value.trim() || null;
      this.renderAllLayers();
      this.renderContent();
      this.emit('statechange');
    });
    nameLabel.appendChild(nameInput);
    beforeLabel.appendChild(beforeInput);
    controls.appendChild(nameLabel);
    controls.appendChild(beforeLabel);
    section.appendChild(controls);
    return section;
  }

  private renderColumnSection(layer: LoadedGeoParquetLayer): HTMLElement {
    const section = document.createElement('div');
    section.className = 'geoparquet-control-section';
    const title = document.createElement('div');
    title.className = 'geoparquet-control-section-title';
    title.textContent = 'Attributes';
    section.appendChild(title);

    const pageSizeLabel = document.createElement('label');
    pageSizeLabel.className = 'geoparquet-control-label';
    pageSizeLabel.textContent = 'Rows per page';
    const pageSizeInput = document.createElement('input');
    pageSizeInput.className = 'geoparquet-control-input';
    pageSizeInput.type = 'number';
    pageSizeInput.min = '1';
    pageSizeInput.step = '100';
    pageSizeInput.value = String(layer.pageSize);
    pageSizeInput.disabled = this.loading;
    pageSizeInput.addEventListener('change', () => {
      const nextPageSize = Number.parseInt(pageSizeInput.value, 10);
      if (Number.isFinite(nextPageSize) && nextPageSize > 0) {
        layer.pageSize = nextPageSize;
      }
    });
    section.appendChild(pageSizeLabel);
    section.appendChild(pageSizeInput);

    const columns = layer.schema.filter((column) => !layer.geoColumns.includes(column.name));
    const selected = new Set(layer.selectedColumns ?? columns.map((column) => column.name));
    const list = document.createElement('div');
    list.className = 'geoparquet-control-column-list';
    columns.slice(0, 30).forEach((column) => {
      const label = document.createElement('label');
      label.className = 'geoparquet-control-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selected.has(column.name);
      input.disabled = this.loading;
      input.addEventListener('change', () => {
        const current = new Set(layer.selectedColumns ?? columns.map((col) => col.name));
        if (input.checked) current.add(column.name);
        else current.delete(column.name);
        layer.selectedColumns = [...current];
      });
      const text = document.createElement('span');
      text.textContent = column.name;
      label.appendChild(input);
      label.appendChild(text);
      list.appendChild(label);
    });
    section.appendChild(list);
    return section;
  }

  private renderActionSection(layer: LoadedGeoParquetLayer): HTMLElement {
    const section = document.createElement('div');
    section.className = 'geoparquet-control-section geoparquet-control-actions';

    const applyButton = document.createElement('button');
    applyButton.className = 'geoparquet-control-button';
    applyButton.type = 'button';
    applyButton.textContent = 'Apply to layer';
    applyButton.disabled = this.loading;
    applyButton.addEventListener('click', () => {
      this.clearLayerData(layer);
      this.runTask('Loading rows...', async () => {
        await this.executeQuery(layer, 0, layer.pageSize, layer.currentViewportBbox);
      }).catch(() => {});
    });
    section.appendChild(applyButton);

    const loadMoreButton = document.createElement('button');
    loadMoreButton.className = 'geoparquet-control-secondary-button';
    loadMoreButton.type = 'button';
    loadMoreButton.textContent = 'Load more';
    loadMoreButton.disabled = this.loading || !this.layerHasMore(layer);
    loadMoreButton.addEventListener('click', () => this.loadMore(layer.id).catch(() => {}));
    section.appendChild(loadMoreButton);

    if (getBboxCovering(layer.geoMetadata, layer.primaryGeoColumn)) {
      const viewportButton = document.createElement('button');
      viewportButton.className = 'geoparquet-control-secondary-button';
      viewportButton.type = 'button';
      viewportButton.textContent = 'Reload viewport';
      viewportButton.disabled = this.loading;
      viewportButton.addEventListener('click', () => this.reloadViewport(layer.id).catch(() => {}));
      section.appendChild(viewportButton);
    }

    return section;
  }

  private renderSelectionSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'geoparquet-control-section';
    const title = document.createElement('div');
    title.className = 'geoparquet-control-section-title';
    title.textContent = `Selected ${this.selectedFeature!.layerName} #${this.selectedFeature!.index + 1}`;
    section.appendChild(title);

    const list = document.createElement('dl');
    list.className = 'geoparquet-control-properties';
    Object.entries(this.selectedFeature!.properties)
      .filter(([key]) => !key.startsWith('__'))
      .slice(0, 20)
      .forEach(([key, value]) => {
        const term = document.createElement('dt');
        term.textContent = key;
        const description = document.createElement('dd');
        description.textContent = String(value ?? '');
        list.appendChild(term);
        list.appendChild(description);
      });
    section.appendChild(list);
    return section;
  }

  private createLayerId(): string {
    return `layer-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private displayNameFromSource(source: string): string {
    return source.split(/[\\/]/).pop() || source;
  }

  private consumeLayerName(source: string): string {
    const layerName = this.nextLayerName.trim();
    if (!layerName) return this.displayNameFromSource(source);
    this.nextLayerName = '';
    return layerName;
  }

  private parseUrlList(value: string): string[] {
    return value
      .split(/[\n,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return entities[char];
    });
  }
}

export const PluginControl = GeoParquetControl;
