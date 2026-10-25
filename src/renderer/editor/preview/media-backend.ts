/**
 * The platform side of the decoder pool: mediabunny demuxers reading `cs-media://` URLs with
 * Range requests (§4.3.10), and WebCodecs `VideoDecoder`s.
 */
import { ALL_FORMATS, EncodedPacketSink, Input, UrlSource, type EncodedPacket } from 'mediabunny';
import type { DecoderBackend, DemuxedPacket, VideoDemuxer } from './decoder-pool';

function wrap(packet: EncodedPacket, raw: WeakMap<DemuxedPacket, EncodedPacket>): DemuxedPacket {
  const wrapped: DemuxedPacket = {
    timestampUs: packet.microsecondTimestamp,
    key: packet.type === 'key',
    chunk: () => packet.toEncodedVideoChunk(),
  };
  raw.set(wrapped, packet);
  return wrapped;
}

export async function openVideoDemuxer(url: string): Promise<VideoDemuxer> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`no video track in ${url}`);
    const config = await track.getDecoderConfig();
    if (!config) throw new Error(`cannot decode the video in ${url}`);
    const sink = new EncodedPacketSink(track);
    const raw = new WeakMap<DemuxedPacket, EncodedPacket>();
    return {
      config,
      async keyPacketAtOrBefore(tUs) {
        const options = { verifyKeyPackets: true };
        const packet =
          (await sink.getKeyPacket(Math.max(0, tUs) / 1_000_000, options)) ??
          (await sink.getFirstKeyPacket(options));
        return packet ? wrap(packet, raw) : null;
      },
      packetsFrom(start) {
        const first = raw.get(start);
        const packets = sink.packets(first);
        return {
          async next() {
            const next = await packets.next();
            return next.done ? next : { done: false, value: wrap(next.value, raw) };
          },
          async return() {
            await packets.return();
            return { done: true, value: undefined };
          },
        };
      },
      dispose() {
        input.dispose();
      },
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

export const webCodecsBackend: DecoderBackend<VideoFrame> = {
  openDemuxer: openVideoDemuxer,
  createDecoder(output, error) {
    return new VideoDecoder({ output, error: (e) => error(e) });
  },
};
