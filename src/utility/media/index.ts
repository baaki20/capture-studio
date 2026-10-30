/**
 * Entry point of the media utility process (§1.3). It owns everything that touches media bytes
 * or runs FFmpeg: stream writers, system-audio capture, finalize, peaks, thumbnails, the
 * encoder probe and exports. Requests are handled by `MediaService`.
 */
import type { MediaUtilityEvent } from '../../shared/ipc/media-utility';
import { installChildReaper } from './child-processes';
import { MediaService } from './service';

const logger = {
  info: (...params: unknown[]) => console.info('media utility:', ...params),
  warn: (...params: unknown[]) => console.warn('media utility:', ...params),
  error: (...params: unknown[]) => console.error('media utility:', ...params),
};

const service = new MediaService({
  emit: (event: MediaUtilityEvent) => process.parentPort.postMessage(event),
  logger,
});

process.parentPort.on('message', (message) => {
  service.handle(message.data, message.ports).catch((error: unknown) => {
    logger.error('request failed', error);
  });
});

// Main asks us to exit on quit (SIGTERM); flush writers and stop captures first, for at most
// 5 s. Exit then SIGKILLs any FFmpeg or pw-record still running; a crash of this process is
// covered by their parent-death signal (child-processes.ts).
installChildReaper(() => service.shutdown(), 5000);
