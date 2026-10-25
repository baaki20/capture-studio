/**
 * Timeline thumbnails (R1.44): `cache/<mediaId>.thumbs.json` indexes JPEG sprite sheets with one
 * thumbnail every `intervalUs` of the file (`utility/media/thumbnails.ts`). `thumbCell` finds the
 * sheet and source rectangle of the thumbnail nearest a file time. Pure.
 */
import type { ThumbnailIndex } from '../../../shared/ipc/media-utility';

export interface ThumbCell {
  sheet: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export function thumbCell(index: ThumbnailIndex, fileUs: number): ThumbCell | null {
  if (index.count === 0) return null;
  const i = Math.min(index.count - 1, Math.max(0, Math.round(fileUs / index.intervalUs)));
  const perSheet = index.columns * index.rows;
  const sheet = Math.floor(i / perSheet);
  if (sheet >= index.sheets.length) return null;
  const cell = i % perSheet;
  return {
    sheet,
    sx: (cell % index.columns) * index.tileWidth,
    sy: Math.floor(cell / index.columns) * index.tileHeight,
    sw: index.tileWidth,
    sh: index.tileHeight,
  };
}
