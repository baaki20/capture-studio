/**
 * Shared by the automation and MCP end-to-end tests: a synthetic project (grey 1280×720 screen,
 * magenta 640×480 camera, a mic with a 440 Hz tone that is silent from 2 s to 4 s, 6 s long) and
 * settings with automation turned on.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../../src/shared/project/schema';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { recordedProject } from '../fixtures/editor-project';

export const ROOT = path.join(import.meta.dirname, '../..');
export const MAIN = path.join(ROOT, 'out/main/index.js');
export const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);
export const FFMPEG = path.join(FFMPEG_DIR, 'ffmpeg');
export const FFPROBE = path.join(FFMPEG_DIR, 'ffprobe');
export const S = 1_000_000;
export const SECONDS = 6;

function ff(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

export function makeProject(projects: string): Project {
  const doc = recordedProject({
    durationUs: SECONDS * S,
    pauses: [],
    system: false,
    screenSize: { width: 1280, height: 720 },
    cameraSize: { width: 640, height: 480 },
    offsets: { screen: 0, camera: 0, microphone: 0 },
  });
  const media = path.join(projects, 'Automation.cstudio', 'media');
  mkdirSync(media, { recursive: true });
  const d = String(SECONDS);
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=30:duration=${d}`,
    '-vf',
    'hue=s=0',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
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
    `color=c=0xFF00FF:s=640x480:r=30:d=${d}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    path.join(media, 'camera.mp4'),
  ]);
  // A tone with silence from 2 s to 4 s.
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${d}`,
    '-af',
    "volume='if(between(t,2,4),0,0.8)':eval=frame",
    '-c:a',
    'libopus',
    '-b:a',
    '64k',
    path.join(media, 'microphone.mp4'),
  ]);
  writeFileSync(
    path.join(projects, 'Automation.cstudio', 'project.json'),
    JSON.stringify(doc, null, 2),
  );
  return doc;
}

/** Writes settings with automation on into a fresh user-data folder. */
export function writeAutomationSettings(userData: string, projects: string): void {
  const settings = createDefaultSettings({
    projectsDir: projects,
    exportsDir: path.join(projects, 'Exports'),
  });
  settings.automation = { enabled: true };
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
}

/** Electron's launch options for the built app in test mode on X11. */
export function launchOptions(userData: string) {
  return {
    // No GPU under Xvfb (CI): Chromium only falls back to software WebGL for the preview when asked.
    args: [
      '--ozone-platform=x11',
      '--enable-unsafe-swiftshader',
      '--disable-features=WebRTCPipeWireCapturer',
      MAIN,
    ],
    cwd: ROOT,
    env: {
      ...process.env,
      CS_TEST: '1',
      CS_USER_DATA_DIR: userData,
      CS_FFMPEG_DIR: FFMPEG_DIR,
      XDG_SESSION_TYPE: 'x11',
      WAYLAND_DISPLAY: '',
    },
  };
}

export function probeDurationSec(file: string): number {
  const out = execFileSync(FFPROBE, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  return Number(out.toString().trim());
}
