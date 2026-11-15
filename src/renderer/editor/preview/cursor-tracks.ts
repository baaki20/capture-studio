/**
 * Loads a project's cursor tracks (v3) for the cursor effects: fetches each cursor media's
 * `cursor.jsonl` through its `cs-media://` URL and parses it (`shared/project/cursor-track.ts`).
 * The preview worker draws without a track until it has loaded and then draws again; the export's
 * render window waits for every track and fails when one cannot be read, so an export never
 * silently drops effects the preview showed.
 */
import { parseCursorTrack, type CursorTrack } from '../../../shared/project/cursor-track';
import type { CursorTracks } from '../../../shared/project/cursor-effects';
import type { Project } from '../../../shared/project/schema';

export type FetchText = (url: string) => Promise<string>;

const fetchText: FetchText = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return response.text();
};

export class CursorTrackStore {
  private readonly loaded = new Map<string, CursorTrack>();
  /** `mediaId url` → its load, so each file is fetched once. */
  private readonly loads = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, string>();

  constructor(private readonly fetcher: FetchText = fetchText) {}

  get tracks(): CursorTracks {
    return this.loaded;
  }

  /** Why a cursor media could not be loaded, by media ID. */
  get failed(): ReadonlyMap<string, string> {
    return this.failures;
  }

  /**
   * Loads the cursor tracks of `doc` that are not loaded yet. Resolves when they are done;
   * `changed` is true when a track was added (the caller draws again).
   */
  async load(doc: Project, urls: Readonly<Record<string, string>>): Promise<{ changed: boolean }> {
    const wanted = doc.media.filter(
      (m) => m.kind === 'cursor' && m.status !== 'missing' && m.status !== 'failed',
    );
    let changed = false;
    await Promise.all(
      wanted.map((m) => {
        const url = urls[m.id];
        if (!url) return Promise.resolve();
        const key = `${m.id} ${url}`;
        let pending = this.loads.get(key);
        if (!pending) {
          pending = (async () => {
            try {
              this.loaded.set(m.id, parseCursorTrack(await this.fetcher(url)));
              this.failures.delete(m.id);
              changed = true;
            } catch (error) {
              this.failures.set(m.id, error instanceof Error ? error.message : String(error));
            }
          })();
          this.loads.set(key, pending);
        }
        return pending;
      }),
    );
    return { changed };
  }
}
