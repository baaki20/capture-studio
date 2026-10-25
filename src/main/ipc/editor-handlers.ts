/**
 * Handlers for the editor's channels (§4.3.11, steps 16–18): opening a project in an editor
 * window (`editor.open`, from the library), waveform peaks and thumbnails (`media.peaks`,
 * `media.thumbs`) and relinking offline media (`project.relink`, R1.29).
 */
import type { EditorMedia } from '../projects/editor-media';
import type { IpcRouter } from './router';

export interface EditorHandlerDeps {
  router: IpcRouter;
  media: EditorMedia;
  /** Opens (or focuses) the editor window of a project that exists. */
  openEditor: (projectId: string) => Promise<void>;
}

export function registerEditorHandlers(deps: EditorHandlerDeps): void {
  const { router, media } = deps;
  router.handle('editor.open', async ({ id }) => {
    await deps.openEditor(id);
    return undefined;
  });
  router.handle('media.peaks', ({ projectId, mediaId }) =>
    media.asset('peaks', projectId, mediaId),
  );
  router.handle('media.thumbs', ({ projectId, mediaId }) =>
    media.asset('thumbs', projectId, mediaId),
  );
  router.handle('project.relink', async ({ id, mediaId }, context) => ({
    relinked: await media.relink(id, mediaId, context.senderId),
  }));
}
