/**
 * Decoded audio for the preview scheduler: a mediabunny `AudioBufferSink` over a `cs-media://`
 * URL (Range requests, §4.3.10), with its small decoded buffers merged into about 1 s PCM chunks
 * (`ChunkAccumulator`).
 */
import { ALL_FORMATS, AudioBufferSink, Input, UrlSource } from 'mediabunny';
import { ChunkAccumulator, type AudioSource, type PcmChunk } from './schedule-math';

export async function openAudioSource(url: string): Promise<AudioSource> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) {
    input.dispose();
    throw new Error(`no audio track in ${url}`);
  }
  if (!(await track.canDecode())) {
    input.dispose();
    throw new Error(`cannot decode the audio in ${url}`);
  }
  const sink = new AudioBufferSink(track);
  return {
    async *chunks(fromFileUs: number, toFileUs: number): AsyncGenerator<PcmChunk> {
      const accumulator = new ChunkAccumulator();
      const buffers = sink.buffers(Math.max(0, fromFileUs) / 1_000_000, toFileUs / 1_000_000);
      for await (const wrapped of buffers) {
        const { buffer } = wrapped;
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
          buffer.getChannelData(c),
        );
        yield* accumulator.push({
          timestampUs: wrapped.timestamp * 1_000_000,
          sampleRate: buffer.sampleRate,
          channels,
        });
      }
      const rest = accumulator.flush();
      if (rest) yield rest;
    },
    dispose() {
      input.dispose();
    },
  };
}
