/**
 * Handlers for the recording, library, project and recovery channels (§4.3.11, steps 10, 12 and
 * 13). Each forwards to its module; errors reach the renderer as rejected invokes.
 */
import type { Logger } from '../../shared/logger';
import { checkMediaPresence } from '../projects/editor-media';
import type { Library } from '../projects/library';
import type { ProjectStore } from '../projects/project-store';
import type { RecoveryService } from '../recording/recovery';
import type { SessionManager } from '../recording/session-manager';
import type { IpcRouter } from './router';

export interface SessionHandlerDeps {
  router: IpcRouter;
  manager: SessionManager;
  library: Library;
  store: ProjectStore;
  recovery: RecoveryService;
  /** Logs which window asked to stop, pause, resume, restart or abort. */
  logger?: Logger;
  /** After a recovery: tell windows the library changed. */
  libraryChanged: () => void;
  /** Starts or stops the setup panel's system-audio meter (R1.5). */
  monitorSystem: (enabled: boolean) => void;
  /** Library → Import: main's folder dialog; null when cancelled (R1.27). */
  chooseImportFolder?: (senderId: number) => Promise<string | null>;
}

/** Invoke channels without a result answer `undefined`. */
const done = (task: Promise<unknown>): Promise<undefined> => task.then(() => undefined);

export function registerSessionHandlers(deps: SessionHandlerDeps): void {
  const { router, manager, library, store, recovery } = deps;

  router.handle('rec.configure', (config) => done(manager.configure(config)));
  router.handle('rec.record', () => manager.record());
  // Same line format as the action bus, so every stop in the log says where it came from.
  const from = (action: string, kind: string) =>
    deps.logger?.info(`action: ${action} (from ${kind} window, state ${manager.state})`);
  router.handle('rec.pause', (_, ctx) => {
    from('pause', ctx.kind);
    return done(manager.pause());
  });
  router.handle('rec.resume', (_, ctx) => {
    from('resume', ctx.kind);
    return done(manager.resume());
  });
  // Stop before recording starts cancels acquisition, the picker or the countdown (R1.10).
  router.handle('rec.stop', (_, ctx) => {
    from('stop', ctx.kind);
    return done(
      ['recording', 'paused'].includes(manager.state) ? manager.stop() : manager.cancel(),
    );
  });
  router.handle('rec.restart', (_, ctx) => {
    from('restart', ctx.kind);
    return done(manager.restart());
  });
  router.handle('rec.abort', (_, ctx) => {
    from('abort', ctx.kind);
    return done(manager.abort());
  });
  router.handle('rec.status', () => manager.status());
  router.handle('rec.monitorSystem', ({ enabled }) => {
    deps.monitorSystem(enabled);
    return undefined;
  });

  router.handle('library.list', () => library.list());
  router.handle('library.rename', ({ id, name }) => library.rename(id, name));
  router.handle('library.trash', ({ id }) => library.trash(id));
  router.handle('library.reveal', ({ id }) => done(library.reveal(id)));
  router.handle('library.openFolder', () => done(library.openFolder()));
  router.handle('library.import', async (_payload, context) => {
    const folder = await deps.chooseImportFolder?.(context.senderId);
    if (!folder) return null;
    const entry = await library.importFolder(folder);
    deps.libraryChanged();
    return entry;
  });

  router.handle('project.open', async ({ id }) => {
    const root = await library.findRoot(id);
    if (!root) throw new Error(`project ${id} was not found`);
    const open = await store.open(id);
    // Media whose file is gone, unreadable or damaged open as offline clips with Relink (R1.29).
    const checked = await checkMediaPresence(root, open.doc);
    return { ...open, doc: checked.doc, offline: checked.offline };
  });
  router.handle('project.save', ({ id, revision, doc }) => store.save(id, revision, doc));

  router.handle('recovery.list', () => recovery.list());
  router.handle('recovery.recover', async ({ id }) => {
    const result = await recovery.recover(id);
    deps.libraryChanged();
    return result;
  });
  router.handle('recovery.discard', ({ id, action }) =>
    done(
      recovery.discard(id, action).then(() => {
        if (action === 'trash') deps.libraryChanged();
      }),
    ),
  );
}
