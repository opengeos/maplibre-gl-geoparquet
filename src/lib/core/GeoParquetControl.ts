import type { IControl, Map as MapLibreMap } from 'maplibre-gl';
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
import { GeoParquetRenderer } from '../geoparquet/renderer';
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
  GeoParquetMetadata,
  GeoParquetState,
} from './types';

const DEFAULT_OPTIONS: Required<Omit<GeoParquetControlOptions, 'sourceUrl' | 'selectedColumns'>> = {
  collapsed: true,
  position: 'top-right',
  title: DEFAULT_TITLE,
  panelWidth: DEFAULT_PANEL_WIDTH,
  className: '',
  pageSize: DEFAULT_PAGE_SIZE,
  fitBoundsOnLoad: true,
  allowLocalFiles: true,
  allowRemoteUrls: true,
};

type EventHandlersMap = globalThis.Map<GeoParquetControlEvent, Set<GeoParquetControlEventHandler>>;

export class GeoParquetControl implements IControl {
  private map?: MapLibreMap;
  private mapContainer?: HTMLElement;
  private container?: HTMLElement;
  private panel?: HTMLElement;
  private content?: HTMLElement;
  private renderer?: GeoParquetRenderer;
  private options: Required<Omit<GeoParquetControlOptions, 'sourceUrl' | 'selectedColumns'>> &
    Pick<GeoParquetControlOptions, 'sourceUrl' | 'selectedColumns'>;
  private eventHandlers: EventHandlersMap = new globalThis.Map();
  private resizeHandler: (() => void) | null = null;
  private mapResizeHandler: (() => void) | null = null;
  private clickOutsideHandler: ((event: MouseEvent) => void) | null = null;

  private collapsed: boolean;
  private source: string | null = null;
  private displaySource = '';
  private localFileName: string | null = null;
  private loading = false;
  private statusMessage = '';
  private error: string | null = null;
  private schema: GeoParquetColumn[] = [];
  private geoMetadata: GeoParquetGeoMetadata | null = null;
  private metadata: GeoParquetMetadata | null = null;
  private selectedColumns: string[] | null = null;
  private pageSize: number;
  private totalRows = -1;
  private filteredCount: number | null = null;
  private currentOffset = 0;
  private lastPageFull = false;
  private primaryGeoColumn: string | null = null;
  private geoColumns: string[] = [];
  private geoArrowResults: GeoArrowResult[] = [];
  private rows: Record<number, Record<string, unknown>> = {};
  private selectedFeature: GeoParquetFeatureSelection | null = null;
  private currentViewportBbox: [number, number, number, number] | null = null;
  private warnings: FileHealthWarning[] = [];

  constructor(options?: Partial<GeoParquetControlOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.collapsed = this.options.collapsed;
    this.pageSize = this.options.pageSize;
    this.selectedColumns = this.options.selectedColumns ?? null;
  }

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    this.mapContainer = map.getContainer();
    this.container = this.createContainer();
    this.panel = this.createPanel();
    this.content = this.panel.querySelector('.geoparquet-control-content') as HTMLElement;
    this.mapContainer.appendChild(this.panel);
    this.renderer = new GeoParquetRenderer(map, {
      onSelect: (index) => this.handleMapSelect(index),
    });
    this.setupEventListeners();

    if (!this.collapsed) {
      this.panel.classList.add('expanded');
      requestAnimationFrame(() => this.updatePanelPosition());
    }
    this.renderContent();

    if (this.options.sourceUrl) {
      this.loadUrl(this.options.sourceUrl).catch(() => {
        // loadUrl renders and emits the error.
      });
    }

    return this.container;
  }

  onRemove(): void {
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    if (this.mapResizeHandler && this.map) this.map.off('resize', this.mapResizeHandler);
    if (this.clickOutsideHandler) document.removeEventListener('click', this.clickOutsideHandler);

    this.renderer?.remove();
    this.panel?.parentNode?.removeChild(this.panel);
    this.container?.parentNode?.removeChild(this.container);
    if (this.localFileName) {
      dropFile(this.localFileName).catch(() => {});
    }

    this.map = undefined;
    this.mapContainer = undefined;
    this.container = undefined;
    this.panel = undefined;
    this.content = undefined;
    this.renderer = undefined;
    this.eventHandlers.clear();
  }

  getState(): GeoParquetState {
    const loadedRows = Object.keys(this.rows).length;
    const activeTotal = this.filteredCount ?? this.totalRows;
    return {
      collapsed: this.collapsed,
      panelWidth: this.options.panelWidth,
      source: this.source,
      displaySource: this.displaySource,
      loading: this.loading,
      statusMessage: this.statusMessage,
      error: this.error,
      schema: [...this.schema],
      selectedColumns: this.selectedColumns ? [...this.selectedColumns] : null,
      pageSize: this.pageSize,
      totalRows: this.totalRows,
      loadedRows,
      hasMore: activeTotal < 0 ? this.lastPageFull : loadedRows < activeTotal,
      primaryGeoColumn: this.primaryGeoColumn,
      selectedFeature: this.selectedFeature,
      metadata: this.metadata,
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

  async loadUrl(url: string): Promise<void> {
    if (!this.options.allowRemoteUrls) {
      throw new Error('Remote URL loading is disabled for this GeoParquet control');
    }

    this.resetData();
    const resolvedUrl = resolveCloudUrl(url.trim());
    this.source = resolvedUrl;
    this.displaySource = resolvedUrl;
    this.emit('loadstart');
    this.setLoading('Checking file...');
    this.warnings = await checkFileHealth(resolvedUrl);
    await this.loadCurrentSource();
  }

  async loadFile(file: File): Promise<void> {
    if (!this.options.allowLocalFiles) {
      throw new Error('Local file loading is disabled for this GeoParquet control');
    }

    this.resetData();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `local_${Date.now()}_${safeName}`;
    this.source = fileName;
    this.localFileName = fileName;
    this.displaySource = file.name;
    this.emit('loadstart');
    this.setLoading(`Reading ${file.name}...`);

    try {
      const buffer = await file.arrayBuffer();
      await initDB((message) => this.setProgress(message));
      await registerLocalFile(fileName, buffer);
      await this.loadCurrentSource();
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  clear(): void {
    if (this.localFileName) {
      dropFile(this.localFileName).catch(() => {});
    }
    this.resetData();
    this.renderer?.clear();
    this.renderContent();
    this.emit('statechange');
  }

  async loadMore(): Promise<void> {
    if (!this.source || this.loading || !this.getState().hasMore) return;
    await this.runTask('Loading more rows...', async () => {
      await this.executeQuery(this.currentOffset, this.pageSize, this.currentViewportBbox);
    });
  }

  async reloadViewport(): Promise<void> {
    if (!this.map || !this.source || !getBboxCovering(this.geoMetadata, this.primaryGeoColumn)) return;
    const bounds = this.map.getBounds();
    this.currentViewportBbox = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ];
    this.rows = {};
    this.geoArrowResults = [];
    this.currentOffset = 0;
    this.selectedFeature = null;
    this.filteredCount = null;
    this.renderer?.clear();

    await this.runTask('Loading current viewport...', async () => {
      this.filteredCount = await queryCount(
        this.source!,
        [],
        this.currentViewportBbox,
        this.primaryGeoColumn,
        getSourceCrsString(this.geoMetadata, this.primaryGeoColumn),
        getBboxCovering(this.geoMetadata, this.primaryGeoColumn)
      );
      await this.executeQuery(0, this.pageSize, this.currentViewportBbox);
    });
  }

  private async loadCurrentSource(): Promise<void> {
    if (!this.source) return;
    try {
      await initDB((message) => this.setProgress(message));
      this.setProgress('Reading GeoParquet metadata...');
      this.metadata = await bootstrapMetadata(this.source, (message) => this.setProgress(message));
      this.schema = this.metadata.schema;
      this.geoMetadata = this.metadata.geoMetadata;
      this.totalRows = this.metadata.totalRows;
      this.primaryGeoColumn = detectPrimaryGeoColumn(this.schema, this.geoMetadata);
      this.geoColumns = this.geoMetadata?.columns
        ? Object.keys(this.geoMetadata.columns)
        : this.primaryGeoColumn
          ? [this.primaryGeoColumn]
          : [];
      if (this.options.selectedColumns) {
        this.selectedColumns = [...this.options.selectedColumns];
      }
      await this.executeQuery(0, this.pageSize, null);
      this.loading = false;
      this.statusMessage = '';
      this.error = null;
      this.renderContent();
      this.emit('load');
      this.emit('statechange');
    } catch (error) {
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
    offset = 0,
    limit: number | null = this.pageSize,
    bbox: [number, number, number, number] | null = null
  ): Promise<void> {
    if (!this.source) return;
    const displayColumns = getDisplayColumns(this.schema, this.geoColumns, this.selectedColumns);
    const displayColumnNames = displayColumns.map((column) => column.name);
    const geoColumn = this.primaryGeoColumn;
    const selectedQueryColumns = geoColumn ? [...displayColumnNames, geoColumn] : displayColumnNames;
    if (selectedQueryColumns.length === 0) return;

    const result = await queryData(this.source, {
      geoColumn,
      bbox,
      sourceCrs: getSourceCrsString(this.geoMetadata, this.primaryGeoColumn),
      columns: selectedQueryColumns,
      bboxCovering: getBboxCovering(this.geoMetadata, this.primaryGeoColumn),
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
      const row: Record<string, unknown> = { __index: globalIndex };
      displayVectors.forEach(({ name, vector }) => {
        row[name] = vector ? formatDisplayValue(vector.get(rowIndex)) : null;
      });
      this.rows[globalIndex] = row;

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
        getKnownGeometryType(this.geoMetadata, this.primaryGeoColumn)
      );
      this.geoArrowResults = this.geoArrowResults.concat(geoArrowResults);
      this.renderer?.setSelectedIndex(this.selectedFeature?.index ?? null);
      this.renderer?.setData(this.geoArrowResults);
      if (offset === 0 && this.options.fitBoundsOnLoad) {
        this.fitToData(geoArrowResults);
      }
    }

    this.currentOffset = offset + result.numRows;
    this.lastPageFull = limit !== null ? result.numRows >= limit : false;
    this.renderContent();
  }

  private fitToData(results: GeoArrowResult[]): void {
    if (!this.map) return;
    let bounds = this.geoMetadata?.columns?.[this.primaryGeoColumn ?? '']?.bbox;
    if (bounds && needsReprojection(this.geoMetadata, this.primaryGeoColumn)) {
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

  private handleMapSelect(index: number | null): void {
    this.selectedFeature =
      index === null
        ? null
        : {
            index,
            properties: this.rows[index] ?? { __index: index },
          };
    this.renderer?.setSelectedIndex(index);
    this.renderer?.setData(this.geoArrowResults);
    this.renderContent();
    this.emit('select', { selection: this.selectedFeature });
    this.emit('statechange');
  }

  private resetData(): void {
    if (this.localFileName) {
      dropFile(this.localFileName).catch(() => {});
    }
    this.source = null;
    this.displaySource = '';
    this.localFileName = null;
    this.loading = false;
    this.statusMessage = '';
    this.error = null;
    this.schema = [];
    this.geoMetadata = null;
    this.metadata = null;
    this.selectedColumns = this.options.selectedColumns ? [...this.options.selectedColumns] : null;
    this.pageSize = this.options.pageSize;
    this.totalRows = -1;
    this.filteredCount = null;
    this.currentOffset = 0;
    this.lastPageFull = false;
    this.primaryGeoColumn = null;
    this.geoColumns = [];
    this.geoArrowResults = [];
    this.rows = {};
    this.selectedFeature = null;
    this.currentViewportBbox = null;
    this.warnings = [];
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

    const fragment = document.createDocumentFragment();
    fragment.appendChild(this.renderLoadSection());
    fragment.appendChild(this.renderStatusSection());
    if (this.metadata) {
      fragment.appendChild(this.renderMetadataSection());
      fragment.appendChild(this.renderColumnSection());
      fragment.appendChild(this.renderActionSection());
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
      label.textContent = 'GeoParquet URL';
      const row = document.createElement('div');
      row.className = 'geoparquet-control-row';
      const input = document.createElement('input');
      input.className = 'geoparquet-control-input';
      input.type = 'url';
      input.placeholder = 'https://example.com/data.parquet';
      input.value = this.source && !this.localFileName ? this.source : '';
      const button = document.createElement('button');
      button.className = 'geoparquet-control-button';
      button.type = 'button';
      button.textContent = 'Load';
      button.disabled = this.loading;
      button.addEventListener('click', () => {
        if (input.value.trim()) {
          this.loadUrl(input.value).catch(() => {});
        }
      });
      row.appendChild(input);
      row.appendChild(button);
      section.appendChild(label);
      section.appendChild(row);
    }

    if (this.options.allowLocalFiles) {
      const fileInput = document.createElement('input');
      fileInput.className = 'geoparquet-control-file';
      fileInput.type = 'file';
      fileInput.accept = '.parquet,.geoparquet,application/octet-stream';
      fileInput.disabled = this.loading;
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) this.loadFile(file).catch(() => {});
      });
      section.appendChild(fileInput);
    }

    if (this.source) {
      const clearButton = document.createElement('button');
      clearButton.className = 'geoparquet-control-secondary-button';
      clearButton.type = 'button';
      clearButton.textContent = 'Clear';
      clearButton.disabled = this.loading;
      clearButton.addEventListener('click', () => this.clear());
      section.appendChild(clearButton);
    }

    return section;
  }

  private renderStatusSection(): HTMLElement {
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
    this.warnings.forEach((warning) => {
      const warningElement = document.createElement('div');
      warningElement.className = 'geoparquet-control-warning';
      warningElement.textContent = `${warning.title}: ${warning.detail}`;
      section.appendChild(warningElement);
    });
    if (!section.childElementCount) {
      const placeholder = document.createElement('p');
      placeholder.className = 'geoparquet-control-placeholder';
      placeholder.textContent = 'Load a GeoParquet file to render it on the map.';
      section.appendChild(placeholder);
    }
    return section;
  }

  private renderMetadataSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'geoparquet-control-section geoparquet-control-summary';
    const items: [string, string][] = [
      ['Source', this.displaySource || ''],
      ['Rows', this.totalRows >= 0 ? this.totalRows.toLocaleString() : 'Unknown'],
      ['Loaded', Object.keys(this.rows).length.toLocaleString()],
      ['Geometry', this.primaryGeoColumn ?? 'Not detected'],
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
    return section;
  }

  private renderColumnSection(): HTMLElement {
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
    pageSizeInput.value = String(this.pageSize);
    pageSizeInput.disabled = this.loading;
    pageSizeInput.addEventListener('change', () => {
      const nextPageSize = Number.parseInt(pageSizeInput.value, 10);
      if (Number.isFinite(nextPageSize) && nextPageSize > 0) {
        this.pageSize = nextPageSize;
      }
    });
    section.appendChild(pageSizeLabel);
    section.appendChild(pageSizeInput);

    const columns = this.schema.filter((column) => !this.geoColumns.includes(column.name));
    const selected = new Set(this.selectedColumns ?? columns.map((column) => column.name));
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
        const current = new Set(this.selectedColumns ?? columns.map((col) => col.name));
        if (input.checked) current.add(column.name);
        else current.delete(column.name);
        this.selectedColumns = [...current];
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

  private renderActionSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'geoparquet-control-section geoparquet-control-actions';

    const applyButton = document.createElement('button');
    applyButton.className = 'geoparquet-control-button';
    applyButton.type = 'button';
    applyButton.textContent = 'Apply';
    applyButton.disabled = this.loading || !this.source;
    applyButton.addEventListener('click', () => {
      this.rows = {};
      this.geoArrowResults = [];
      this.currentOffset = 0;
      this.filteredCount = null;
      this.selectedFeature = null;
      this.renderer?.clear();
      this.runTask('Loading rows...', async () => {
        await this.executeQuery(0, this.pageSize, this.currentViewportBbox);
      }).catch(() => {});
    });
    section.appendChild(applyButton);

    const loadMoreButton = document.createElement('button');
    loadMoreButton.className = 'geoparquet-control-secondary-button';
    loadMoreButton.type = 'button';
    loadMoreButton.textContent = 'Load more';
    loadMoreButton.disabled = this.loading || !this.getState().hasMore;
    loadMoreButton.addEventListener('click', () => this.loadMore().catch(() => {}));
    section.appendChild(loadMoreButton);

    if (getBboxCovering(this.geoMetadata, this.primaryGeoColumn)) {
      const viewportButton = document.createElement('button');
      viewportButton.className = 'geoparquet-control-secondary-button';
      viewportButton.type = 'button';
      viewportButton.textContent = 'Reload viewport';
      viewportButton.disabled = this.loading;
      viewportButton.addEventListener('click', () => this.reloadViewport().catch(() => {}));
      section.appendChild(viewportButton);
    }

    return section;
  }

  private renderSelectionSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'geoparquet-control-section';
    const title = document.createElement('div');
    title.className = 'geoparquet-control-section-title';
    title.textContent = `Selected #${this.selectedFeature!.index + 1}`;
    section.appendChild(title);

    const list = document.createElement('dl');
    list.className = 'geoparquet-control-properties';
    Object.entries(this.selectedFeature!.properties)
      .filter(([key]) => key !== '__index')
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
}

export const PluginControl = GeoParquetControl;
