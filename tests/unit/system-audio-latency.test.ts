import { describe, expect, it } from 'vitest';
import {
  estimateSinkOutputLatencyUs,
  outputLatencyUs,
  parseClockSettings,
} from '../../src/main/system-audio/linux-latency';

const DEV_MACHINE = `Found "settings" metadata 32
update: id:0 key:'log.level' value:'2' type:''
update: id:0 key:'clock.rate' value:'48000' type:''
update: id:0 key:'clock.allowed-rates' value:'[ 48000 ]' type:''
update: id:0 key:'clock.quantum' value:'1024' type:''
update: id:0 key:'clock.min-quantum' value:'32' type:''
update: id:0 key:'clock.max-quantum' value:'2048' type:''
update: id:0 key:'clock.force-quantum' value:'0' type:''
update: id:0 key:'clock.force-rate' value:'0' type:''
`;

describe('system audio output latency', () => {
  it('matches the 42 ms measured by the sync test on the dev machine', () => {
    expect(parseClockSettings(DEV_MACHINE)).toEqual({ quantum: 1024, rate: 48_000 });
    expect(outputLatencyUs(parseClockSettings(DEV_MACHINE))).toBe(42_667);
  });

  it('prefers a forced quantum and rate', () => {
    const forced = DEV_MACHINE.replace(
      "force-quantum' value:'0'",
      "force-quantum' value:'256'",
    ).replace("force-rate' value:'0'", "force-rate' value:'44100'");
    expect(parseClockSettings(forced)).toEqual({ quantum: 256, rate: 44_100 });
  });

  it('falls back to 1024 at 48 kHz when pw-metadata fails', async () => {
    const latency = await estimateSinkOutputLatencyUs(() =>
      Promise.resolve({ code: null, stdout: '', stderr: '', error: 'ENOENT' }),
    );
    expect(latency).toBe(42_667);
  });
});
