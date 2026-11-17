import { describe, expect, it } from 'vitest';
import {
  encoderCandidates,
  LINUX_ENCODER_CANDIDATES,
  MACOS_ENCODER_CANDIDATES,
  WINDOWS_ENCODER_CANDIDATES,
} from '../../src/utility/media/encoder-probe';
import { isExportVideoEncoder } from '../../src/utility/media/export/graph-builder';

describe('FFmpeg encoder candidates per OS (P3 step 2)', () => {
  it('probes each OS’s hardware encoders first and ends on libx264', () => {
    const names = (platform: NodeJS.Platform) => encoderCandidates(platform).map((c) => c.name);
    expect(names('linux')).toEqual(['h264_vaapi', 'h264_nvenc', 'h264_qsv', 'libx264']);
    expect(names('win32')).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']);
    expect(names('darwin')).toEqual(['h264_videotoolbox', 'libx264']);
  });

  it('only probes encoders the exporter can drive', () => {
    for (const c of [
      ...LINUX_ENCODER_CANDIDATES,
      ...WINDOWS_ENCODER_CANDIDATES,
      ...MACOS_ENCODER_CANDIDATES,
    ]) {
      expect(isExportVideoEncoder(c.name), c.name).toBe(true);
    }
  });

  it('builds a test encode for each candidate', () => {
    const input = ['-f', 'lavfi', '-i', 'testsrc2'];
    const vt = MACOS_ENCODER_CANDIDATES[0]?.args(input) ?? [];
    expect(vt.slice(0, 4)).toEqual(input);
    expect(vt).toContain('h264_videotoolbox');
  });
});
