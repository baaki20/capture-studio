import { describe, expect, it } from 'vitest';
import { retryTransientFsErrors, TRANSIENT_RETRY_DELAYS_MS } from '../../src/shared/fs-retry';

const fsError = (code: string) => Object.assign(new Error(code), { code });

/** An operation that fails `failures` times with `code`, then returns 'done'. */
function flaky(failures: number, code: string) {
  let calls = 0;
  const op = () => (++calls <= failures ? Promise.reject(fsError(code)) : Promise.resolve('done'));
  return { op, calls: () => calls };
}

describe('retryTransientFsErrors', () => {
  const sleeps: number[] = [];
  const sleep = (ms: number) => (sleeps.push(ms), Promise.resolve());

  it('retries a file held open by another process on Windows', async () => {
    sleeps.length = 0;
    const f = flaky(3, 'EBUSY');
    await expect(retryTransientFsErrors(f.op, 'win32', sleep)).resolves.toBe('done');
    expect(f.calls()).toBe(4);
    expect(sleeps).toEqual(TRANSIENT_RETRY_DELAYS_MS.slice(0, 3));
  });

  it('gives up after the last back-off', async () => {
    const f = flaky(99, 'EPERM');
    await expect(retryTransientFsErrors(f.op, 'win32', sleep)).rejects.toThrow('EPERM');
    expect(f.calls()).toBe(TRANSIENT_RETRY_DELAYS_MS.length + 1);
  });

  it('fails at once for other errors and on other platforms', async () => {
    const missing = flaky(1, 'ENOENT');
    await expect(retryTransientFsErrors(missing.op, 'win32', sleep)).rejects.toThrow('ENOENT');
    expect(missing.calls()).toBe(1);
    const linux = flaky(1, 'EACCES');
    await expect(retryTransientFsErrors(linux.op, 'linux', sleep)).rejects.toThrow('EACCES');
    expect(linux.calls()).toBe(1);
  });
});
