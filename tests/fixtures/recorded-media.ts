/**
 * A recorded project folder with real media made by FFmpeg: a `testsrc2` screen of any size, a
 * magenta 640×480 camera and a 440 Hz microphone. Used by the media E2E tests and the Wayland
 * harness's 4K preview check (G).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../../src/shared/project/schema';
import { recordedProject } from './editor-project';

export interface RecordedMediaOptions {
  ffmpeg: string;
  dir: string;
  id: string;
  name: string;
  size: [number, number];
  seconds: number;
  fps: number;
}

export function buildRecordedProject(options: RecordedMediaOptions): {
  root: string;
  doc: Project;
} {
  const { ffmpeg, size, seconds, fps } = options;
  const ff = (args: string[]) =>
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const doc: Project = {
    ...recordedProject({
      durationUs: seconds * 1_000_000,
      pauses: [],
      system: false,
      screenSize: { width: size[0], height: size[1] },
      cameraSize: { width: 640, height: 480 },
      offsets: { screen: 0, camera: 0, microphone: 0 },
    }),
    id: options.id,
    name: options.name,
  };
  for (const m of doc.media) m.clockRatio = 1;
  doc.timeline.canvas = { ...doc.timeline.canvas, width: 1280, height: 720 };
  const root = path.join(options.dir, `${options.name}.cstudio`);
  const media = path.join(root, 'media');
  mkdirSync(media, { recursive: true });
  const d = String(seconds);
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${String(size[0])}x${String(size[1])}:rate=${String(fps)}:duration=${d}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '30',
    '-pix_fmt',
    'yuv420p',
    path.join(media, 'screen.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=0xFF00FF:s=640x480:r=${String(fps)}:d=${d}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    path.join(media, 'camera.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=f=440:r=48000:d=${d}`,
    '-c:a',
    'aac',
    path.join(media, 'microphone.mp4'),
  ]);
  writeFileSync(path.join(root, 'project.json'), JSON.stringify(doc, null, 2));
  return { root, doc };
}
