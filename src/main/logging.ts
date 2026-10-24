/**
 * electron-log setup (§1.2): one rotating file in `<userData>/logs/main.log` (the previous file is
 * kept as `main.old.log` when it passes 5 MB) plus the console in development.
 */
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function initLogging(): typeof log {
  log.transports.file.resolvePathFn = (variables) =>
    path.join(app.getPath('userData'), 'logs', variables.fileName ?? 'main.log');
  log.transports.file.maxSize = MAX_LOG_BYTES;
  log.transports.file.level = 'info';
  log.transports.console.level = app.isPackaged ? false : 'debug';
  log.errorHandler.startCatching({ showDialog: false });
  return log;
}

export { log };

/** Copies renderer and worker console warnings and errors into the main log. */
export function forwardRendererConsole(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (details) => {
      if (details.level !== 'error' && details.level !== 'warning') return;
      const where = `${details.sourceId}:${String(details.lineNumber)}`;
      const line = `renderer ${details.level}: ${details.message} (${where})`;
      if (details.level === 'error') log.error(line);
      else log.warn(line);
    });
  });
}
