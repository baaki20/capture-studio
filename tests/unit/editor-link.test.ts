import { describe, expect, it, vi } from 'vitest';
import {
  EditorLinkError,
  EditorLinks,
  type EditorContentsLike,
} from '../../src/main/automation/editor-link';
import type { EditorAutomationRequest } from '../../src/shared/ipc/editor-automation';
import { recordedProject } from '../fixtures/editor-project';

function contents(id: number) {
  let destroyed = false;
  return {
    id,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
  };
}

function setup() {
  const windows = new Map<string, ReturnType<typeof contents>>();
  const sent: { to: number; request: EditorAutomationRequest }[] = [];
  let nextId = 10;
  const open = vi.fn((projectId: string) => {
    const c = contents(nextId++);
    windows.set(projectId, c);
    return c;
  });
  const links = new EditorLinks({
    open,
    contentsOf: (projectId) => windows.get(projectId) ?? null,
    send: (to: EditorContentsLike, request) => {
      sent.push({ to: to.id, request });
      return !to.isDestroyed();
    },
    readyTimeoutMs: 1_000,
    commandTimeoutMs: 1_000,
  });
  return { links, windows, sent, open };
}

describe('EditorLinks', () => {
  it('opens the editor when needed and waits until it has loaded the project', async () => {
    const { links, windows, open } = setup();
    const pending = links.ensure('prj_A');
    expect(open).toHaveBeenCalledWith('prj_A');
    expect(links.live('prj_A')).toBeNull();
    expect(links.markReady('prj_A', windows.get('prj_A')!.id)).toBe(true);
    const link = await pending;
    expect(links.live('prj_A')).toBe(link);
    // Already open and loaded: no second open.
    expect(await links.ensure('prj_A')).toBe(link);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('uses an editor the user opened, without opening another', async () => {
    const { links, windows, open } = setup();
    windows.set('prj_B', contents(42));
    expect(links.markReady('prj_B', 42)).toBe(true);
    await links.ensure('prj_B');
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a ready claim from another window', () => {
    const { links, windows } = setup();
    windows.set('prj_C', contents(5));
    expect(links.markReady('prj_C', 6)).toBe(false);
    expect(links.markReady('prj_D', 5)).toBe(false);
    expect(links.live('prj_C')).toBeNull();
  });

  it('sends commands and resolves validated replies', async () => {
    const { links, windows, sent } = setup();
    windows.set('prj_E', contents(7));
    links.markReady('prj_E', 7);
    const link = await links.ensure('prj_E');
    const doc = recordedProject();
    const snapshot = link.command('snapshot', {});
    expect(sent[0]).toMatchObject({ to: 7, request: { command: 'snapshot', payload: {} } });
    links.handleReply(7, {
      requestId: sent[0]!.request.requestId,
      ok: true,
      value: { doc, version: 3, readOnly: false },
    });
    expect(await snapshot).toMatchObject({ version: 3, readOnly: false });

    const refused = link.command('undo', {});
    links.handleReply(7, {
      requestId: sent[1]!.request.requestId,
      ok: false,
      error: { code: 'read-only', message: 'no' },
    });
    await expect(refused).rejects.toMatchObject({ code: 'read-only' });

    const offContract = link.command('flush', {});
    links.handleReply(7, { requestId: sent[2]!.request.requestId, ok: true, value: { nope: 1 } });
    await expect(offContract).rejects.toMatchObject({ code: 'internal' });
  });

  it('fails outstanding work when the window closes or never loads', async () => {
    vi.useFakeTimers();
    try {
      const { links, windows } = setup();
      const never = links.ensure('prj_F');
      const expectation = expect(never).rejects.toBeInstanceOf(EditorLinkError);
      vi.advanceTimersByTime(1_001);
      await expectation;

      windows.set('prj_G', contents(9));
      links.markReady('prj_G', 9);
      const link = await links.ensure('prj_G');
      const command = link.command('snapshot', {});
      links.closed('prj_G');
      await expect(command).rejects.toMatchObject({ code: 'editor-unavailable' });
      expect(links.live('prj_G')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
