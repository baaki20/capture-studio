/**
 * Quitting during a recording (finding F-7): preparing sessions are cancelled, recording ones
 * are saved, discarded or kept per the user's answer (saved without asking for SIGTERM), a
 * finalize is waited for, and saving is bounded in time.
 */
import { describe, expect, it, vi } from 'vitest';
import { QuitGuard, type QuitChoice, type RecorderLike } from '../../src/main/quit-guard';
import type { RecordingState } from '../../src/main/recording/state-machine';

class FakeRecorder implements RecorderLike {
  calls: string[] = [];
  stopDelayMs = 0;
  constructor(public state: RecordingState) {}
  async stop() {
    this.calls.push('stop');
    await new Promise((r) => setTimeout(r, this.stopDelayMs));
    this.state = 'completed';
  }
  abort() {
    this.calls.push('abort');
    this.state = 'aborted';
    return Promise.resolve();
  }
  cancel() {
    this.calls.push('cancel');
    this.state = 'configuring';
    return Promise.resolve();
  }
  settled() {
    this.calls.push('settled');
    this.state = 'completed';
    return Promise.resolve();
  }
}

function setup(state: RecordingState, answer: QuitChoice = 'save', timeoutMs?: number) {
  const recorder = new FakeRecorder(state);
  const ask = vi.fn(() => Promise.resolve(answer));
  const quit = vi.fn();
  const guard = new QuitGuard({
    recorder: () => recorder,
    ask,
    quit,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const event = () => ({ preventDefault: vi.fn() });
  return { recorder, ask, quit, guard, event };
}

describe('QuitGuard (F-7)', () => {
  it('lets an idle app quit at once', () => {
    const { guard, event, ask } = setup('idle');
    const e = event();
    expect(guard.beforeQuit(e)).toBe(true);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([
    ['save', 'stop'],
    ['discard', 'abort'],
  ] as const)(
    'asks when the user quits while recording: %s → %s, then quits',
    async (answer, call) => {
      const { guard, event, ask, quit, recorder } = setup('recording', answer);
      const e = event();
      quit.mockImplementationOnce(() => guard.beforeQuit(e));
      guard.quitInteractively();
      expect(e.preventDefault).toHaveBeenCalled();
      await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(2));
      expect(ask).toHaveBeenCalledOnce();
      expect(recorder.calls).toEqual([call]);
      expect(guard.beforeQuit(event())).toBe(true); // the second quit goes through
    },
  );

  it('keeps recording when the user cancels', async () => {
    const { guard, event, quit, recorder } = setup('paused', 'cancel');
    quit.mockImplementationOnce(() => guard.beforeQuit(event()));
    guard.quitInteractively();
    await new Promise((r) => setTimeout(r, 10));
    expect(quit).toHaveBeenCalledOnce(); // only the quit that asked
    expect(recorder.calls).toEqual([]);
    expect(guard.isQuitting).toBe(false);
  });

  it('saves without asking on a quit the UI did not start (SIGTERM, logout)', async () => {
    // Electron turns SIGTERM into a plain quit: before-quit without quitInteractively.
    const { guard, event, ask, quit, recorder } = setup('recording', 'discard');
    expect(guard.beforeQuit(event())).toBe(false);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(ask).not.toHaveBeenCalled();
    expect(recorder.calls).toEqual(['stop']);
  });

  it('saves without asking for the harness (quitWithoutAsking)', async () => {
    const { guard, event, ask, quit, recorder } = setup('recording', 'discard');
    quit.mockImplementationOnce(() => guard.beforeQuit(event()));
    guard.quitWithoutAsking();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(2));
    expect(ask).not.toHaveBeenCalled();
    expect(recorder.calls).toEqual(['stop']);
  });

  it('cancels a recording being prepared without asking', async () => {
    const { guard, event, ask, quit, recorder } = setup('countdown');
    expect(guard.beforeQuit(event())).toBe(false);
    await vi.waitFor(() => expect(quit).toHaveBeenCalled());
    expect(ask).not.toHaveBeenCalled();
    expect(recorder.calls).toEqual(['cancel']);
  });

  it('waits for a finalize in progress', async () => {
    const { guard, event, quit, recorder } = setup('finalizing');
    expect(guard.beforeQuit(event())).toBe(false);
    await vi.waitFor(() => expect(quit).toHaveBeenCalled());
    expect(recorder.calls).toEqual(['settled']);
  });

  it('quits anyway when saving takes too long', async () => {
    const { guard, event, quit, recorder } = setup('recording', 'save', 20);
    recorder.stopDelayMs = 5_000;
    guard.beforeQuit(event());
    await vi.waitFor(() => expect(quit).toHaveBeenCalled(), { timeout: 1_000 });
  });

  it('asks only once when quit is requested repeatedly', async () => {
    const { guard, event, ask, quit } = setup('recording');
    quit.mockImplementationOnce(() => {
      guard.beforeQuit(event());
      guard.beforeQuit(event());
    });
    guard.quitInteractively();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(2));
    expect(ask).toHaveBeenCalledOnce();
  });
});

describe('application menu (F-7)', () => {
  it('routes File → Quit and Ctrl+Q through the interactive quit', async () => {
    const { appMenuTemplate } = await import('../../src/main/app-menu');
    const quit = vi.fn();
    const file = appMenuTemplate(quit)[0]!;
    const item = (file.submenu as { accelerator?: string; click?: () => void }[])[0]!;
    expect(item.accelerator).toBe('CmdOrCtrl+Q');
    item.click?.();
    expect(quit).toHaveBeenCalledOnce();
  });
});
