/**
 * MP4 chapters from chapter markers (R2.20). Each chapter marker starts a chapter that runs to the
 * next one or to the end of the export; when the first chapter starts after 0:00, a "Start"
 * chapter covers the beginning (players and video sites expect chapters from 0:00). FFmpeg reads
 * them from an ffmetadata file (`-f ffmetadata -i … -map_chapters`).
 */
import type { Us } from '../time';
import type { Marker } from '../project/schema';

export interface Chapter {
  startUs: Us;
  endUs: Us;
  title: string;
}

/** The chapters of an export `durationUs` long; empty without chapter markers. */
export function exportChapters(markers: readonly Marker[] | undefined, durationUs: Us): Chapter[] {
  const starts = (markers ?? [])
    .filter((m) => m.chapter && m.tUs < durationUs)
    .sort((a, b) => a.tUs - b.tUs);
  if (starts.length === 0) return [];
  const list = starts.map((m, i) => ({
    startUs: m.tUs,
    title: m.label.trim() === '' ? `Chapter ${String(i + 1)}` : m.label.trim(),
  }));
  if ((list[0]?.startUs ?? 0) > 0) list.unshift({ startUs: 0, title: 'Start' });
  return list.map((c, i) => ({ ...c, endUs: list[i + 1]?.startUs ?? durationUs }));
}

/** ffmetadata escapes `=`, `;`, `#`, `\` and line breaks with a backslash. */
function escapeValue(value: string): string {
  return value.replace(/[=;#\\\n]/g, (c) => `\\${c}`);
}

/** The ffmetadata file for `chapters` (times in µs). */
export function ffmetadataText(chapters: readonly Chapter[]): string {
  const lines = [';FFMETADATA1'];
  for (const c of chapters) {
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000000',
      `START=${String(c.startUs)}`,
      `END=${String(c.endUs)}`,
      `title=${escapeValue(c.title)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
