/**
 * Media panel of the inspector (R2.21, R2.22): import pictures, videos and audio, or add a take
 * from another recording, at the playhead. Main puts the files into the project and returns their
 * media; the editor adds them with one `addMedia` (one undo step) on new tracks. Large videos get
 * preview proxies in the background (`ProxyUrls`).
 */
import { useState } from 'react';
import { importedTracks } from '../../../shared/project/media-import';
import type { Project } from '../../../shared/project/schema';
import { useEditor } from '../EditorContext';
import styles from '../Editor.module.css';
import { useApply } from './hooks';

export function MediaSection({ doc: _doc }: { doc: Project }) {
  const apply = useApply();
  const { api, projectId, docStore, ui } = useEditor();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (label: string, work: () => Promise<string | null>) => {
    setBusy(label);
    try {
      ui.getState().setStatus(await work());
    } catch (error) {
      ui.getState().setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  const importFiles = () =>
    run('Importing…', async () => {
      const result = await api.media.importMedia?.(projectId);
      if (!result || result.files.length === 0) return null;
      docStore.getState().addMediaUrls(result.urls);
      apply({
        type: 'addMedia',
        media: result.files.flatMap((f) => f.media),
        tracks: result.files.flatMap((f, i) => importedTracks(f.name, f.items, String(i))),
        atUs: ui.getState().playheadUs,
      });
      return `Imported ${String(result.files.length)} file${result.files.length === 1 ? '' : 's'}.`;
    });
  const addTake = () =>
    run('Adding the take…', async () => {
      const result = await api.media.addTake?.(projectId);
      if (!result) return null;
      if (result.tracks.length === 0) return 'That project has no media to add.';
      docStore.getState().addMediaUrls(result.urls);
      apply({
        type: 'addMedia',
        media: result.media,
        tracks: result.tracks,
        atUs: ui.getState().playheadUs,
      });
      return 'Added the take; move its clips to line it up.';
    });
  return (
    <section data-testid="media-panel">
      <h2>Media</h2>
      <p className={styles.muted}>Added at the playhead on new tracks.</p>
      <span className={styles.group}>
        <button type="button" disabled={busy !== null} onClick={() => void importFiles()}>
          Import…
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void addTake()}>
          Add a take…
        </button>
      </span>
      {busy ? <p className={styles.muted}>{busy}</p> : null}
    </section>
  );
}
