/**
 * FFmpeg H.264 encoder probe (§1.4 `encode.ffmpeg.hw`, §4.3.4, §9.4). Lists the encoders the
 * bundled build has, then verifies each candidate with a 1 s test encode to the null muxer.
 * libx264 must work; hardware encoders fail on machines without a driver, and that is fine.
 */
import { execFile } from 'node:child_process';
import type { FfmpegEncoderProbe, FfmpegEncoderReport } from '../../shared/capabilities/types';
import { runFfmpeg } from './ffmpeg-runner';

export interface EncoderCandidate {
  name: string;
  kind: FfmpegEncoderProbe['kind'];
  /** Arguments between the test input and `-f null -`. */
  args: (input: readonly string[]) => string[];
}

const TEST_INPUT = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=1'] as const;

/** Linux candidates, preferred first. */
export const LINUX_ENCODER_CANDIDATES: readonly EncoderCandidate[] = [
  {
    name: 'h264_vaapi',
    kind: 'vaapi',
    args: (input) => [
      '-vaapi_device',
      '/dev/dri/renderD128',
      ...input,
      '-vf',
      'format=nv12,hwupload',
      '-c:v',
      'h264_vaapi',
    ],
  },
  { name: 'h264_nvenc', kind: 'nvenc', args: (input) => [...input, '-c:v', 'h264_nvenc'] },
  { name: 'h264_qsv', kind: 'qsv', args: (input) => [...input, '-c:v', 'h264_qsv'] },
  {
    name: 'libx264',
    kind: 'software',
    args: (input) => [...input, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
  },
];

/** Encoder names from `ffmpeg -encoders` output (lines like ` V....D libx264  …`). */
export function parseEncoderList(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const m = /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
    if (m?.[1] && m[1] !== '=') names.add(m[1]);
  }
  return names;
}

function listEncoders(ffmpegPath: string, signal?: AbortSignal): Promise<Set<string> | string> {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      ['-hide_banner', '-encoders'],
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      },
      (error, stdout) => resolve(error ? error.message : parseEncoderList(stdout)),
    );
  });
}

function lastLines(text: string, n = 2): string {
  return text.trim().split('\n').slice(-n).join(' ').slice(0, 300);
}

export interface ProbeEncodersOptions {
  ffmpegPath: string;
  candidates?: readonly EncoderCandidate[];
  /** Per test encode. Default 10 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => Date;
}

export async function probeEncoders(options: ProbeEncodersOptions): Promise<FfmpegEncoderReport> {
  const candidates = options.candidates ?? LINUX_ENCODER_CANDIDATES;
  const listed = await listEncoders(options.ffmpegPath, options.signal);
  const encoders: FfmpegEncoderProbe[] = [];

  for (const candidate of candidates) {
    if (typeof listed === 'string') {
      encoders.push({ ...pick(candidate), listed: false, works: false, error: listed });
      continue;
    }
    if (!listed.has(candidate.name)) {
      encoders.push({
        ...pick(candidate),
        listed: false,
        works: false,
        error: 'not in this build',
      });
      continue;
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const result = await runFfmpeg({
      ffmpegPath: options.ffmpegPath,
      args: ['-loglevel', 'error', ...candidate.args(TEST_INPUT), '-f', 'null', '-'],
      signal,
    });
    encoders.push({
      ...pick(candidate),
      listed: true,
      works: result.ok,
      error: result.ok
        ? null
        : result.error.kind === 'failed'
          ? lastLines(result.error.stderrTail) || `exit ${String(result.error.exitCode)}`
          : result.error.kind === 'cancelled'
            ? 'timed out'
            : result.error.message,
    });
  }

  return {
    probedAt: (options.now ?? (() => new Date()))().toISOString(),
    encoders,
    hardware: encoders.find((e) => e.kind !== 'software' && e.works)?.name ?? null,
    software: encoders.find((e) => e.kind === 'software' && e.works)?.name ?? null,
  };
}

function pick(candidate: EncoderCandidate): Pick<FfmpegEncoderProbe, 'name' | 'kind'> {
  return { name: candidate.name, kind: candidate.kind };
}
