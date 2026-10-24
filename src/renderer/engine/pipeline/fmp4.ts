/**
 * One fragmented-MP4 writer per stream (§1.5, S5): mediabunny `Output` +
 * `Mp4OutputFormat({fastStart: 'fragmented'})` + `StreamTarget` with `chunked: false`, so every
 * finished fragment reaches the sink (the stream port) at once (§9.6: no 1 MiB buffering).
 *
 * Fragments start on keyframes. Video fragments are as long as the keyframe interval (≤ 1 s, see
 * `KeyframeCadence`); audio packets are all keys, and `AUDIO_FRAGMENT_SEC` keeps an audio fragment
 * within 1 s with 20 ms Opus packets.
 *
 * Packets are queued in order on one promise chain; the first muxer error is kept and stops
 * further packets (the worker then fails the stream).
 */
import {
  EncodedAudioPacketSource,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type EncodedPacket,
  type StreamTargetChunk,
} from 'mediabunny';
import type { CodecFamily } from '../encoder-select';
import type { MuxerChunk } from './port-sink';

export const VIDEO_FRAGMENT_SEC = 0.5;
export const AUDIO_FRAGMENT_SEC = 0.98;

const MEDIABUNNY_VIDEO_CODEC = { h264: 'avc', vp9: 'vp9', av1: 'av1', vp8: 'vp8' } as const;

export type Fmp4Track = { media: 'video'; family: CodecFamily } | { media: 'audio' };

type VideoMeta = Parameters<EncodedVideoPacketSource['add']>[1];
type AudioMeta = Parameters<EncodedAudioPacketSource['add']>[1];

export class FragmentedMp4Writer {
  private readonly output: Output;
  private readonly video: EncodedVideoPacketSource | null = null;
  private readonly audio: EncodedAudioPacketSource | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private packets = 0;

  constructor(sink: (chunk: MuxerChunk) => void, track: Fmp4Track) {
    const target = new StreamTarget(
      new WritableStream<StreamTargetChunk>({ write: (chunk) => sink(chunk) }),
      { chunked: false },
    );
    this.output = new Output({
      format: new Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: track.media === 'video' ? VIDEO_FRAGMENT_SEC : AUDIO_FRAGMENT_SEC,
      }),
      target,
    });
    if (track.media === 'video') {
      this.video = new EncodedVideoPacketSource(MEDIABUNNY_VIDEO_CODEC[track.family]);
      // No frameRate metadata: it would snap the VFR timestamps to a 1/fps grid.
      this.output.addVideoTrack(this.video);
    } else {
      this.audio = new EncodedAudioPacketSource('opus');
      this.output.addAudioTrack(this.audio);
    }
  }

  start(): Promise<void> {
    return this.output.start();
  }

  get packetCount(): number {
    return this.packets;
  }

  get error(): unknown {
    return this.failure;
  }

  /** Queues one packet in decode order; pass the encoder's metadata (decoder config) with it. */
  addPacket(packet: EncodedPacket, meta?: VideoMeta | AudioMeta): void {
    this.packets += 1;
    this.chain = this.chain.then(async () => {
      if (this.failure !== null) return;
      try {
        if (this.video) await this.video.add(packet, meta);
        else if (this.audio) await this.audio.add(packet, meta as AudioMeta);
      } catch (error) {
        this.failure = error;
      }
    });
  }

  /** Waits for queued packets, then writes the last fragment. */
  async finalize(): Promise<void> {
    await this.chain;
    if (this.failure !== null) {
      throw this.failure instanceof Error ? this.failure : new Error('muxer failed');
    }
    if (this.packets === 0) {
      await this.output.cancel();
      return;
    }
    await this.output.finalize();
  }

  async cancel(): Promise<void> {
    await this.chain;
    if (this.output.state !== 'finalized' && this.output.state !== 'canceled') {
      await this.output.cancel();
    }
  }
}
