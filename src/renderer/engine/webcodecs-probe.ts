/**
 * The real `EncoderProbe` for `selectVideoEncoder` (§4.3.4): `VideoEncoder.isConfigSupported`,
 * then a 1 s warm-up encode of synthetic text-heavy frames (screen-like content) at the
 * candidate's size and rate. The warm-up passes when every frame came out without an error.
 */
import type { EncoderProbe, VideoEncoderConfigLike } from './encoder-select';

const WARM_UP_TIMEOUT_MS = 10_000;

export function createWebCodecsProbe(): EncoderProbe {
  return {
    async isConfigSupported(config: VideoEncoderConfigLike) {
      return VideoEncoder.isConfigSupported(config);
    },
    warmUp: warmUpEncode,
  };
}

async function warmUpEncode(config: VideoEncoderConfigLike): Promise<boolean> {
  const frames = Math.max(1, Math.round(config.framerate));
  const state: { outputs: number; failure: Error | null } = { outputs: 0, failure: null };
  const encoder = new VideoEncoder({
    output: () => {
      state.outputs += 1;
    },
    error: (e) => {
      state.failure = e;
    },
  });
  try {
    encoder.configure(config);
    const canvas = new OffscreenCanvas(config.width, config.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const frameUs = Math.round(1_000_000 / config.framerate);
    for (let i = 0; i < frames && state.failure === null; i += 1) {
      ctx.fillStyle = `hsl(${String((i * 37) % 360)} 40% 30%)`;
      ctx.fillRect(0, 0, config.width, config.height);
      ctx.fillStyle = '#fff';
      ctx.font = `${String(Math.max(12, Math.round(config.height / 30)))}px monospace`;
      for (let line = 0; line < 12; line += 1) {
        ctx.fillText(
          `warm-up ${String(i)} line ${String(line)} the quick brown fox`,
          10 + i,
          40 + (line * config.height) / 14,
        );
      }
      const frame = new VideoFrame(canvas, { timestamp: i * frameUs, duration: frameUs });
      try {
        encoder.encode(frame, { keyFrame: i === 0 });
      } finally {
        frame.close();
      }
    }
    await Promise.race([
      encoder.flush(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('warm-up timed out')), WARM_UP_TIMEOUT_MS),
      ),
    ]);
    if (state.failure !== null) throw state.failure;
    return state.outputs >= frames;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}
