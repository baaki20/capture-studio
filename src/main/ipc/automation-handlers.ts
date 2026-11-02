/**
 * Automation wiring in main: the editor's `automation.ready` / `automation.reply` invokes, the
 * editor links, the method handlers and the socket, which listens only while Settings →
 * Assistants → Automation is on (and stops at once when it is turned off).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AUTOMATION_DIR_NAME, AUTOMATION_SOCKET_NAME } from '../../shared/automation/protocol';
import type { Logger } from '../../shared/logger';
import type { Settings } from '../../shared/settings/schema';
import { AutomationServer } from '../automation/automation-server';
import { AutomationService, type AutomationServiceDeps } from '../automation/automation-service';
import { EditorLinks, type EditorContentsLike } from '../automation/editor-link';
import type { IpcRouter } from './router';

export function automationSocketPath(userDataDir: string): string {
  return path.join(userDataDir, AUTOMATION_DIR_NAME, AUTOMATION_SOCKET_NAME);
}

export interface AutomationDeps extends Omit<
  AutomationServiceDeps,
  'editors' | 'readFile' | 'openProjects'
> {
  router: Pick<IpcRouter, 'handle' | 'send'>;
  editorHost: {
    open(projectId: string): { webContents: EditorContentsLike };
    contentsOf(projectId: string): EditorContentsLike | null;
    readonly openProjects: string[];
    onWindowClosed(listener: (projectId: string) => void): () => void;
  };
  settings: { get(): Settings; onChange(listener: (settings: Settings) => void): () => void };
  socketPath: string;
  logger: Logger;
}

export interface AutomationHandle {
  readonly socketPath: string;
  readonly listening: boolean;
  /** Stops the socket and fails outstanding editor requests (app quit). */
  dispose(): Promise<void>;
}

export function registerAutomation(deps: AutomationDeps): AutomationHandle {
  const { router, editorHost, logger } = deps;
  const links = new EditorLinks({
    open: (projectId) => editorHost.open(projectId).webContents,
    contentsOf: (projectId) => editorHost.contentsOf(projectId),
    send: (contents, request) =>
      router.send(contents as Parameters<IpcRouter['send']>[0], 'automation.request', request),
  });

  router.handle('automation.ready', ({ projectId }, context) => {
    if (!links.markReady(projectId, context.senderId)) {
      logger.warn(`automation: ignored ready for ${projectId} from another window`);
    }
    return undefined;
  });
  router.handle('automation.reply', (reply, context) => {
    links.handleReply(context.senderId, reply);
    return undefined;
  });
  const offClosed = editorHost.onWindowClosed((projectId) => links.closed(projectId));

  const service = new AutomationService({
    ...deps,
    editors: links,
    openProjects: () => editorHost.openProjects,
    readFile: async (file) => {
      const bytes = await fs.readFile(file);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  });
  const server = new AutomationServer({
    socketPath: deps.socketPath,
    handlers: service.handlers,
    logger,
  });

  // Start and stop in order, whatever order the setting flips in.
  let queue: Promise<void> = Promise.resolve();
  const apply = (enabled: boolean) => {
    queue = queue
      .then(() => (enabled ? server.start() : server.stop()))
      .catch((error: unknown) => {
        logger.error(`automation: could not ${enabled ? 'start' : 'stop'} the socket`, error);
      });
  };
  apply(deps.settings.get().automation.enabled);
  let enabled = deps.settings.get().automation.enabled;
  const offSettings = deps.settings.onChange((settings) => {
    if (settings.automation.enabled === enabled) return;
    enabled = settings.automation.enabled;
    apply(enabled);
  });

  return {
    socketPath: deps.socketPath,
    get listening() {
      return server.listening;
    },
    dispose: async () => {
      offSettings();
      offClosed();
      service.dispose();
      links.dispose();
      await queue;
      await server.stop();
    },
  };
}
