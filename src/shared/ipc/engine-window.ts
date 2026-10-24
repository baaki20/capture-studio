/**
 * How the engine preload hands `engine.ports` MessagePorts to the engine page. contextBridge
 * cannot carry ports, so the preload re-posts them as a same-window message (Electron's
 * documented pattern). Kept free of zod so the preload bundle stays small.
 */
import type { EnginePorts } from './contract';

export const ENGINE_PORTS_MESSAGE = 'cs:engine.ports';

/** `event.data` of the window message; the ports are in `event.ports`. Check `event.source === window`. */
export interface EnginePortsWindowMessage {
  type: typeof ENGINE_PORTS_MESSAGE;
  payload: EnginePorts;
}
