/**
 * Entry of the hidden capture-engine window (§1.3). Registers the `engine.*` command handlers,
 * receives the stream and clock MessagePorts (re-posted by the preload as a same-window message),
 * and tells main it is ready.
 */
import {
  ENGINE_PORTS_MESSAGE,
  type EnginePortsWindowMessage,
} from '../../shared/ipc/engine-window';
import { CaptureEngine } from './engine';

const api = window.csEngine;
const engine = new CaptureEngine(api);

window.addEventListener('message', (event: MessageEvent) => {
  // Only the preload's re-post: same window, our message type.
  if (event.source !== window) return;
  const data = event.data as Partial<EnginePortsWindowMessage> | null;
  if (data?.type !== ENGINE_PORTS_MESSAGE) return;
  engine.receivePorts(data.payload, event.ports);
});

api.onCommand('engine.acquire', (payload) => engine.acquire(payload));
api.onCommand('engine.start', (payload) => engine.start(payload));
api.onCommand('engine.pause', (payload) => engine.pause(payload));
api.onCommand('engine.resume', (payload) => engine.resume(payload));
api.onCommand('engine.stop', (payload) => engine.stop(payload));
api.onCommand('engine.snapshot', () => engine.snapshot());

window.addEventListener('beforeunload', () => engine.release());

api.ready();
