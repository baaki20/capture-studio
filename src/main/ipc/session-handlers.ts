/**
 * Handlers for the recording, library, project and recovery channels (§4.3.11, steps 10, 12 and
 * 13). Each forwards to its module; errors reach the renderer as rejected invokes.
 */
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
  /** After a recovery: tell windows the library changed. */
  libraryChanged: () => void;
  /** Starts or stops the setup panel's system-audio meter (R1.5). */
  monitorSystem: (enabled: boolean) => void;
}

/** Invoke channels without a result answer `undefined`. */
const done = (task: Promise<unknown>): Promise<undefined> => task.then(() => undefined);

export function registerSessionHandlers(deps: SessionHandlerDeps): void {
  const { router, manager, library, store, recovery } = deps;

  router.handle('rec.configure', (config) => done(manager.configure(config)));
  router.handle('rec.record', () => manager.record());
  router.handle('rec.pause', () => done(manager.pause()));
  router.handle('rec.resume', () => done(manager.resume()));
  // Stop before recording starts cancels acquisition, the picker or the countdown (R1.10).
  router.handle('rec.stop', () =>
    done(['recording', 'paused'].includes(manager.state) ? manager.stop() : manager.cancel()),
  );
  router.handle('rec.restart', () => done(manager.restart()));
  router.handle('rec.abort', () => done(manager.abort()));
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

  router.handle('project.open', async ({ id }) => {
    if (!(await library.findRoot(id))) throw new Error(`project ${id} was not found`);
    return store.open(id);
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
