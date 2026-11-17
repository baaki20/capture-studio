/**
 * A project with a cursor track (v3): the example project with its screen at the canvas size
 * (1920×1080, no crop, so screen pixels are canvas pixels) and a cursor media for it. Tests
 * clone and mutate it, so always call the function to get a fresh copy.
 */
import {
  cursorTrackFromEvents,
  type CursorEvent,
  type CursorTrack,
} from '../../src/shared/project/cursor-track';
import type { CursorTrackEntry, Project } from '../../src/shared/project/schema';
import { exampleProject } from './example-project';

export const CURSOR_MEDIA_ID = 'med_k';

/** A path across the screen with clicks at 2 s and 2.3 s (file time = session time). */
export const CURSOR_EVENTS: CursorEvent[] = [
  { tUs: 0, x: 200, y: 200 },
  { tUs: 1_000_000, x: 960, y: 540 },
  { tUs: 2_000_000, x: 960, y: 540, action: 'down', button: 'left' },
  { tUs: 2_080_000, x: 960, y: 540, action: 'up', button: 'left' },
  { tUs: 2_300_000, x: 1000, y: 560, action: 'down', button: 'left' },
  { tUs: 2_380_000, x: 1000, y: 560, action: 'up', button: 'left' },
  { tUs: 6_000_000, x: 1700, y: 900 },
  { tUs: 9_000_000, x: 1700, y: 900, action: 'down', button: 'left' },
  { tUs: 9_050_000, x: 1700, y: 900, action: 'up', button: 'left' },
];

export const CURSOR_HEADER = { sampleRateHz: 120, width: 1920, height: 1080 };

export function cursorTrack(events: CursorEvent[] = CURSOR_EVENTS): CursorTrack {
  return cursorTrackFromEvents(CURSOR_HEADER, events);
}

export function cursorMediaItem(inVideo: boolean): CursorTrackEntry {
  return {
    id: CURSOR_MEDIA_ID,
    path: 'media/cursor.jsonl',
    status: 'ok',
    durationUs: 738_500_000,
    screenMediaId: 'med_s',
    inVideo,
    sampleRateHz: 120,
    samples: CURSOR_EVENTS.length,
    clicks: 3,
  };
}

export function cursorProject(options: { inVideo?: boolean } = {}): Project {
  const doc = exampleProject();
  const screen = doc.media.find((m) => m.id === 'med_s');
  if (screen?.video) {
    screen.video.width = 1920;
    screen.video.height = 1080;
  }
  const track = doc.timeline.tracks[0];
  if (track?.type === 'video' && track.layout.kind === 'screen') track.layout.crop = null;
  doc.recording = doc.recording && {
    ...doc.recording,
    platform: { ...doc.recording.platform, session: 'x11' },
  };
  doc.cursorTracks.push(cursorMediaItem(options.inVideo ?? false));
  return doc;
}
