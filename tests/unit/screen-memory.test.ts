import { describe, expect, it, vi } from 'vitest';
import { ScreenSourceMemory, selectWithMemory } from '../../src/main/screen-memory';

const logger = { info: vi.fn(), warn: () => undefined, error: () => undefined };
const source = (id: string) => ({
  sourceId: id,
  label: 'Monitor',
  maxWidth: 1920,
  maxHeight: 1080,
});

describe('remembered screen (P3 step 8)', () => {
  it('asks once per kind and reuses the answer, marked as reused', async () => {
    const memory = new ScreenSourceMemory(logger);
    const ask = vi.fn((kind: 'screen' | 'window') => Promise.resolve(source(`${kind}:1`)));
    expect(await selectWithMemory(memory, 'screen', ask)).toEqual(source('screen:1'));
    expect(await selectWithMemory(memory, 'screen', ask)).toEqual({
      ...source('screen:1'),
      reused: true,
    });
    expect(ask).toHaveBeenCalledTimes(1);
    // Window mode asks, and replaces the remembered screen.
    await selectWithMemory(memory, 'window', ask);
    expect(memory.current).toEqual({ kind: 'window', label: 'Monitor' });
    await selectWithMemory(memory, 'screen', ask);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('remembers nothing when the portal was cancelled, and forgets on request', async () => {
    const memory = new ScreenSourceMemory(logger);
    const changes = vi.fn();
    memory.onChange(changes);
    expect(await selectWithMemory(memory, 'screen', () => Promise.resolve(null))).toBeNull();
    expect(memory.current).toBeNull();
    await selectWithMemory(memory, 'screen', () => Promise.resolve(source('screen:2')));
    memory.forget('user');
    expect(memory.current).toBeNull();
    expect(changes).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith('recording: forgot the shared screen (user)');
    // Forgetting again changes nothing.
    memory.forget('stale');
    expect(changes).toHaveBeenCalledTimes(2);
  });
});
