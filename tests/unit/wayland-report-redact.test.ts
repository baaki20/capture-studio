import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { machineInfo, redact } from '../../tests/wayland/lib/report';

describe('Wayland report redaction (reports are public)', () => {
  it('removes the home folder, user name and hostname', () => {
    const user = os.userInfo().username;
    const text = `run folder: ${os.homedir()}/.cache/x · /home/${user}/y · host ${os.hostname()} · /run/user/${String(os.userInfo().uid)}/bus`;
    const out = redact(text);
    expect(out).toBe('run folder: ~/.cache/x · ~/y · host test-machine · /run/user/<uid>/bus');
  });

  it('replaces device names, including the other channel variant of one headset', () => {
    const out = redact(
      'notice: Microphone (Acme X1 headset with microphone Mono) disconnected; sink Acme X1 headset with microphone Analog Stereo',
      [{ text: 'Acme X1 headset with microphone Mono', as: 'USB headset' }],
    );
    expect(out).toBe('notice: Microphone (USB headset) disconnected; sink USB headset');
  });

  it('records no hostname, kernel, CPU or memory', () => {
    expect(Object.keys(machineInfo())).not.toEqual(
      expect.arrayContaining(['host', 'kernel', 'cpus', 'memory']),
    );
    expect(JSON.stringify(machineInfo())).not.toContain(os.hostname());
  });
});
