import { describe, expect, it } from 'vitest';
import {
  ENGINE_COMMANDS,
  ENGINE_EVENTS,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  isInvokeChannel,
  WINDOW_KINDS,
} from '../../src/shared/ipc/contract';
import {
  estimateClockOffset,
  MediaUtilityEventSchema,
  MediaUtilityRequestSchema,
  StreamPortMessageSchema,
} from '../../src/shared/ipc/media-utility';

const req = (channel: keyof typeof INVOKE_CHANNELS, payload: unknown) =>
  INVOKE_CHANNELS[channel].request.safeParse(payload).success;

describe('IPC contract (§4.3.11)', () => {
  it('lists every Phase 1 invoke channel, event and engine channel', () => {
    for (const channel of [
      'caps.get',
      'settings.get',
      'settings.patch',
      'rec.configure',
      'rec.record',
      'rec.pause',
      'rec.resume',
      'rec.stop',
      'rec.restart',
      'rec.abort',
      'rec.status',
      'rec.monitorSystem',
      'picker.load',
      'picker.submit',
      'picker.cancel',
      'library.list',
      'library.rename',
      'library.trash',
      'library.reveal',
      'library.import',
      'library.openFolder',
      'project.open',
      'project.save',
      'project.relink',
      'media.peaks',
      'media.thumbs',
      'export.probeEncoders',
      'export.start',
      'export.cancel',
      'recovery.list',
      'recovery.recover',
      'recovery.discard',
      'diag.copyReport',
    ]) {
      expect(isInvokeChannel(channel), channel).toBe(true);
    }
    expect(Object.keys(EVENT_CHANNELS).sort()).toEqual(
      [
        'caps.changed',
        'export.done',
        'export.error',
        'export.progress',
        'library.changed',
        'rec.completed',
        'rec.levels',
        'rec.notice',
        'rec.state',
        'rec.stats',
      ].sort(),
    );
    expect(Object.keys(ENGINE_COMMANDS)).toEqual([
      'engine.acquire',
      'engine.start',
      'engine.pause',
      'engine.resume',
      'engine.stop',
      'engine.snapshot',
    ]);
    expect(Object.keys(ENGINE_EVENTS)).toEqual(
      expect.arrayContaining([
        'engine.stats',
        'engine.trackEnded',
        'engine.reply',
        'engine.levels',
      ]),
    );
    expect(isInvokeChannel('fs.readFile')).toBe(false);
    expect(isInvokeChannel('toString')).toBe(false);
  });

  it('only lets known windows use channels, and no UI channel is open to the engine', () => {
    for (const [channel, spec] of Object.entries(INVOKE_CHANNELS)) {
      expect(spec.windows.length, channel).toBeGreaterThan(0);
      for (const w of spec.windows) expect(WINDOW_KINDS).toContain(w);
      expect(spec.windows, channel).not.toContain('engine');
    }
  });

  it('validates settings patches and refuses path changes from renderers', () => {
    expect(req('settings.patch', { recorder: { fps: 60, micProcessing: { ns: true } } })).toBe(
      true,
    );
    expect(req('settings.patch', { theme: 'dark' })).toBe(true);
    expect(req('settings.patch', { recorder: { fps: 45 } })).toBe(false);
    expect(req('settings.patch', { projectsDir: '/etc' })).toBe(false);
    expect(req('settings.patch', { recorder: { evil: 1 } })).toBe(false);
    expect(req('settings.patch', undefined)).toBe(false);
  });

  it('validates recorder configuration and picker selections', () => {
    const config = {
      captureMode: 'region',
      cameraId: null,
      micId: 'abc',
      systemAudio: true,
      micProcessing: { ec: false, ns: false, agc: false },
      fps: 30,
      quality: 'high',
      countdownSec: 3,
    };
    expect(req('rec.configure', config)).toBe(true);
    expect(req('rec.configure', { ...config, countdownSec: 4 })).toBe(false);
    expect(
      req('picker.submit', {
        sourceWidth: 1920,
        sourceHeight: 1080,
        rect: { x: 0, y: 0, width: 64, height: 64 },
      }),
    ).toBe(true);
    expect(
      req('picker.submit', {
        sourceWidth: 1920,
        sourceHeight: 1080,
        rect: { x: -1, y: 0, width: 64, height: 64 },
      }),
    ).toBe(false);
  });

  it('validates the step 11 recorder UI payloads (levels, completion, picker still, snapshot)', () => {
    const levels = EVENT_CHANNELS['rec.levels'].payload;
    expect(levels.safeParse({ mic: 0.5 }).success).toBe(true);
    expect(levels.safeParse({ system: 0 }).success).toBe(true);
    expect(levels.safeParse({ mic: -1 }).success).toBe(false);
    expect(
      EVENT_CHANNELS['rec.completed'].payload.safeParse({
        projectId: 'prj_1',
        name: 'Lesson',
        afterRecording: 'open-editor',
      }).success,
    ).toBe(true);
    expect(req('rec.monitorSystem', { enabled: true })).toBe(true);
    expect(req('rec.monitorSystem', { enabled: 'yes' })).toBe(false);
    const load = INVOKE_CHANNELS['picker.load'].response;
    const still = { sourceWidth: 1920, sourceHeight: 1080, lastRegion: null };
    expect(load.safeParse({ ...still, imageUrl: 'data:image/png;base64,AA==' }).success).toBe(true);
    expect(load.safeParse({ ...still, imageUrl: 'file:///etc/passwd' }).success).toBe(false);
    const snapshot = ENGINE_COMMANDS['engine.snapshot'].response;
    expect(snapshot.safeParse({ width: 2, height: 2, png: new Uint8Array([1]) }).success).toBe(
      true,
    );
    expect(snapshot.safeParse({ width: 2, height: 2, png: 'AA==' }).success).toBe(false);
    expect(ENGINE_EVENTS['engine.levels'].safeParse({ atUs: 1, mic: 0.2 }).success).toBe(true);
  });

  it('takes no payload where none is expected', () => {
    expect(req('rec.stop', undefined)).toBe(true);
    expect(req('rec.stop', { now: true })).toBe(false);
  });

  it('refers to projects by id only', () => {
    expect(req('library.trash', { id: 'prj_01' })).toBe(true);
    expect(req('library.trash', { id: 'prj_01', path: '/' })).toBe(false);
    expect(req('library.trash', { id: '' })).toBe(false);
    expect(
      req('export.start', {
        projectId: 'p',
        options: { resolution: '720p', fps: 'project', quality: 'draft', encoder: 'auto' },
      }),
    ).toBe(true);
    expect(
      req('export.start', {
        projectId: 'p',
        outputPath: '/x',
        options: { resolution: '720p', fps: 30, quality: 'draft', encoder: 'auto' },
      }),
    ).toBe(false);
  });

  it('validates engine command payloads', () => {
    const acquire = ENGINE_COMMANDS['engine.acquire'].request;
    expect(
      acquire.safeParse({
        screen: { sourceId: 'screen:1:0', maxWidth: 3840, maxHeight: 2160, fps: 30 },
        camera: null,
        mic: {
          deviceId: 'd',
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      }).success,
    ).toBe(true);
    expect(
      acquire.safeParse({ screen: { sourceId: 'x', fps: 30 }, camera: null, mic: null }).success,
    ).toBe(false);
  });
});

describe('media utility messages', () => {
  it('validates requests and port messages', () => {
    expect(
      MediaUtilityRequestSchema.safeParse({
        type: 'stream.open',
        streamId: 's1',
        kind: 'screen',
        dir: '/p/media',
      }).success,
    ).toBe(true);
    expect(
      MediaUtilityRequestSchema.safeParse({
        type: 'stream.open',
        streamId: 's1',
        kind: 'desktop',
        dir: '/p',
      }).success,
    ).toBe(false);
    expect(
      MediaUtilityRequestSchema.safeParse({
        type: 'job',
        jobId: 'j',
        job: {
          kind: 'finalize',
          dir: '/p',
          streams: [{ kind: 'mic', expect: { video: 0, audio: 1 } }],
        },
      }).success,
    ).toBe(true);
    expect(
      MediaUtilityRequestSchema.safeParse({ type: 'job', jobId: 'j', job: { kind: 'rm-rf' } })
        .success,
    ).toBe(false);
    expect(
      MediaUtilityEventSchema.safeParse({ type: 'job.done', jobId: 'j', kind: 'peaks', result: {} })
        .success,
    ).toBe(true);

    expect(
      StreamPortMessageSchema.safeParse({ type: 'chunk', position: 0, data: new Uint8Array(4) })
        .success,
    ).toBe(true);
    expect(
      StreamPortMessageSchema.safeParse({ type: 'chunk', position: 0, data: new ArrayBuffer(4) })
        .success,
    ).toBe(true);
    expect(
      StreamPortMessageSchema.safeParse({ type: 'chunk', position: -1, data: new Uint8Array(4) })
        .success,
    ).toBe(false);
    expect(
      StreamPortMessageSchema.safeParse({ type: 'chunk', position: 0, data: 'AAAA' }).success,
    ).toBe(false);
  });

  it('estimates the clock offset from the fastest round trip', () => {
    // Remote clock runs 5000 µs ahead; the 2nd sample has the shortest round trip.
    const offset = estimateClockOffset([
      { sentUs: 0, remoteUs: 5_900, receivedUs: 1_000 },
      { sentUs: 2_000, remoteUs: 7_050, receivedUs: 2_100 },
      { sentUs: 3_000, remoteUs: 8_500, receivedUs: 3_600 },
    ]);
    expect(offset).toEqual({ offsetUs: 5_000, rttUs: 100, samples: 3 });
    expect(estimateClockOffset([])).toBeNull();
  });
});
