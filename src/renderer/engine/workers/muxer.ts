/**
 * The worker-side muxer: a `FragmentedMp4Writer` fed with WebCodecs chunks (converted to
 * mediabunny packets) whose bytes go to the stream port.
 */
import { EncodedPacket } from 'mediabunny';
import { FragmentedMp4Writer, type Fmp4Track } from '../pipeline/fmp4';
import type { PortWriteForwarder } from '../pipeline/port-sink';

export class StreamMuxer extends FragmentedMp4Writer {
  constructor(forwarder: PortWriteForwarder, track: Fmp4Track) {
    super((chunk) => forwarder.write(chunk), track);
  }

  /** Queues one encoded chunk; a missing duration becomes `fallbackDurationUs`. */
  add(
    chunk: EncodedVideoChunk | EncodedAudioChunk,
    meta: EncodedVideoChunkMetadata | EncodedAudioChunkMetadata | undefined,
    fallbackDurationUs: number,
  ): void {
    let packet = EncodedPacket.fromEncodedChunk(chunk);
    if (!(packet.duration > 0)) packet = packet.clone({ duration: fallbackDurationUs / 1e6 });
    this.addPacket(packet, meta);
  }
}
