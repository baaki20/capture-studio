/**
 * Remembers warm-up outcomes so encoder selection can run twice without paying the 1 s warm-up
 * twice (§4.3.4). `engine.acquire` selects with the real source size (from the first frame) to
 * prime the cache; `engine.start` selects again with the chosen quality, which only changes the
 * bitrate, so the cached warm-up result for the same codec, size and acceleration is reused.
 * `isConfigSupported` is cheap and always asked again.
 */
import type { EncoderProbe, SupportLike, VideoEncoderConfigLike } from '../encoder-select';

function warmUpKey(config: VideoEncoderConfigLike): string {
  return [
    config.codec,
    config.width,
    config.height,
    config.framerate,
    config.hardwareAcceleration,
    config.latencyMode ?? '',
  ].join('|');
}

export class CachedEncoderProbe implements EncoderProbe {
  private readonly warmUps = new Map<string, Promise<boolean>>();

  constructor(private readonly inner: EncoderProbe) {}

  isConfigSupported(config: VideoEncoderConfigLike): Promise<SupportLike> {
    return this.inner.isConfigSupported(config);
  }

  warmUp(config: VideoEncoderConfigLike): Promise<boolean> {
    const key = warmUpKey(config);
    let pending = this.warmUps.get(key);
    if (!pending) {
      pending = this.inner.warmUp(config).catch((error: unknown) => {
        // A thrown warm-up is not cached as a result: forget it and rethrow.
        this.warmUps.delete(key);
        throw error;
      });
      this.warmUps.set(key, pending);
    }
    return pending;
  }

  clear(): void {
    this.warmUps.clear();
  }
}
