/**
 * Test-only control channel (§4.6.5): request/response by id over a Unix socket, events to every
 * client, errors for unknown commands, throwing handlers and malformed lines, a 0600 socket,
 * and the free-space override used for R1.17.
 */
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FreeSpaceOverride, HarnessChannel } from '../../src/main/diagnostics/harness-channel';
import { ChannelClient } from '../wayland/lib/channel-client';

let dir: string;
let channel: HarnessChannel;
let socketPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-harness-'));
  socketPath = path.join(dir, 'control.sock');
  channel = new HarnessChannel({
    socketPath,
    handlers: {
      echo: (args) => args,
      slow: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return 'done';
      },
      boom: () => {
        throw new Error('it broke');
      },
      nothing: () => undefined,
    },
  });
  await channel.start();
});

afterEach(async () => {
  await channel.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('harness channel', () => {
  it('answers requests by id and reports errors', async () => {
    const client = await ChannelClient.connect(socketPath, 2_000);
    try {
      const [a, b] = await Promise.all([client.call('slow'), client.call('echo', { value: 42 })]);
      expect(a).toBe('done');
      expect(b).toEqual({ value: 42 });
      await expect(client.call('nothing')).resolves.toBeNull();
      await expect(client.call('boom')).rejects.toThrow('it broke');
      await expect(client.call('toString')).rejects.toThrow('unknown command');
      expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600);
    } finally {
      client.close();
    }
  });

  it('broadcasts events to every client', async () => {
    const one = await ChannelClient.connect(socketPath, 2_000);
    const two = await ChannelClient.connect(socketPath, 2_000);
    try {
      await expect.poll(() => channel.clientCount).toBe(2);
      const got = Promise.all([
        one.waitFor<{ state: string }>('state', (p) => p.state === 'recording', 2_000),
        two.waitFor<{ state: string }>('state', undefined, 2_000),
      ]);
      channel.broadcast('state', { state: 'recording' });
      expect(await got).toEqual([{ state: 'recording' }, { state: 'recording' }]);
    } finally {
      one.close();
      two.close();
    }
  });

  it('survives a malformed line', async () => {
    const raw = net.createConnection(socketPath);
    const answer = new Promise<string>((resolve) => raw.once('data', (d) => resolve(String(d))));
    raw.write('{not json\n');
    expect(JSON.parse(await answer)).toMatchObject({ id: null, ok: false });
    raw.destroy();
    const client = await ChannelClient.connect(socketPath, 2_000);
    await expect(client.call('echo', 1)).resolves.toBe(1);
    client.close();
  });
});

describe('FreeSpaceOverride', () => {
  it('returns the override while set and the real value otherwise', async () => {
    const free = new FreeSpaceOverride(() => Promise.resolve(9e12));
    expect(await free.probe('/x')).toBe(9e12);
    free.set(400e6);
    expect(await free.probe('/x')).toBe(400e6);
    expect(free.current).toBe(400e6);
    free.set(null);
    expect(await free.probe('/x')).toBe(9e12);
    expect(() => free.set(-1)).toThrow();
  });
});
