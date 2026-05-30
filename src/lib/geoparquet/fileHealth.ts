import { formatFileSize } from '@walkthru-earth/objex-utils';

const MAX_RECOMMENDED_FILE_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_RECOMMENDED_FOOTER_SIZE = 10 * 1024 * 1024;

export interface FileHealthWarning {
  title: string;
  detail: string;
}

export async function checkFileHealth(
  url: string,
  { timeout = 5000 }: { timeout?: number } = {}
): Promise<FileHealthWarning[]> {
  const warnings: FileHealthWarning[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=-8' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.status !== 206) return warnings;

    let fileSize: number | null = null;
    const contentRange = response.headers.get('Content-Range');
    const match = contentRange?.match(/\/(\d+)$/);
    if (match) fileSize = Number.parseInt(match[1], 10);

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== 8) return warnings;

    const magic = new Uint8Array(buffer, 4, 4);
    if (magic[0] !== 0x50 || magic[1] !== 0x41 || magic[2] !== 0x52 || magic[3] !== 0x31) {
      return warnings;
    }

    const footerSize = new DataView(buffer).getUint32(0, true);
    if (footerSize > MAX_RECOMMENDED_FOOTER_SIZE) {
      warnings.push({
        title: `Large Parquet footer (${formatFileSize(footerSize)})`,
        detail: 'Initial loading may be slow while reading schema and metadata.',
      });
    }
    if (fileSize && fileSize > MAX_RECOMMENDED_FILE_SIZE) {
      warnings.push({
        title: `Very large file (${formatFileSize(fileSize)})`,
        detail: 'Use column selection and viewport reloads to avoid loading too much data at once.',
      });
    }
  } catch {
    clearTimeout(timer);
  }

  return warnings;
}
