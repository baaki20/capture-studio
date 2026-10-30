/**
 * Child process for `writer-kill.test.ts` (§4.6.2, R1.21): records a screen stream the way the
 * app does, in real time, until it is SIGKILLed.
 *
 * Packets of a real H.264 file are re-muxed with the engine's `FragmentedMp4Writer` (mediabunny,
 * fragmented MP4, `chunked: false`) and sent through the engine's `PortWriteForwarder` over a
 * MessagePort to the utility's `attachStreamPort` + `StreamWriter`, which `pwrite`s them to
 * `<dir>/screen.rec.mp4`. Each packet is fed at its own timestamp after the start, so media time
 * equals wall time since the start.
 *
 * Prints one JSON line `{"startedAt": <epoch ms of media time 0>}` when the first packet is fed.
 *
 * Usage: `node --import tsx stream-writer-child.ts <source.mp4> <dir>`.
 */
import { readFileSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import { FragmentedMp4Writer } from '../../../src/renderer/engine/pipeline/fmp4';
import {
  PortWriteForwarder,
  type StreamPortLike,
} from '../../../src/renderer/engine/pipeline/port-sink';
import {
  attachStreamPort,
  StreamWriter,
  type PortLike,
} from '../../../src/utility/media/stream-writer';

const [source = '', dir = ''] = process.argv.slice(2);

const channel = new MessageChannel();
const writer = new StreamWriter({ dir, kind: 'screen' });
// Electron's MessagePortMain delivers `{data}` events; a Node port delivers the value itself.
const utilityEnd: PortLike = {
  on: ((event: 'message' | 'close', listener: (arg?: { data: unknown }) => void) =>
    event === 'message'
      ? channel.port2.on('message', (data: unknown) => listener({ data }))
      : channel.port2.on('close', () => listener())) as PortLike['on'],
  postMessage: (message) => channel.port2.postMessage(message),
  start: () => channel.port2.start(),
  close: () => channel.port2.close(),
};
attachStreamPort(utilityEnd, writer);
const forwarder = new PortWriteForwarder(channel.port1 as unknown as StreamPortLike);

const input = new Input({ source: new BufferSource(readFileSync(source)), formats: ALL_FORMATS });
const track = await input.getPrimaryVideoTrack();
if (!track) throw new Error('no video track');
const decoderConfig = await track.getDecoderConfig();
if (!decoderConfig) throw new Error('no decoder config');

const muxer = new FragmentedMp4Writer((chunk) => forwarder.write(chunk), {
  media: 'video',
  family: 'h264',
});
await muxer.start();

let startedAt: number | null = null;
let first = true;
for await (const packet of new EncodedPacketSink(track).packets()) {
  if (startedAt === null) {
    startedAt = Date.now();
    process.stdout.write(`${JSON.stringify({ startedAt })}\n`);
  }
  const due = startedAt + packet.timestamp * 1000;
  const wait = due - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  muxer.addPacket(packet, first ? { decoderConfig } : undefined);
  first = false;
}
// Ran out of source before the kill: keep the process alive so the kill still lands.
setInterval(() => undefined, 60_000);
