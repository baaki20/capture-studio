/**
 * Entry point of the media utility process (§1.3). It owns everything that touches media bytes
 * or runs FFmpeg: stream writers, system-audio capture, finalize, peaks, thumbnails and the
 * encoder probe. Requests are handled by `MediaService`.
 */
import type { MediaUtilityEvent } from '../../shared/ipc/media-utility';
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

// Main asks us to exit on quit; flush writers and stop captures first.
process.on('SIGTERM', () => {
  void service.shutdown().finally(() => process.exit(0));
});
