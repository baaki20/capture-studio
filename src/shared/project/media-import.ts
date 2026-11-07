/**
 * Adding media to a project (v2, R2.21, R2.22): imported files and extra takes arrive as media
 * plus the tracks that show them; `addMedia` puts them in at the playhead.
 *
 * - An imported file gets its own tracks: a video track (screen layout, contained in the canvas)
 *   and/or an audio track, their clips linked so picture and sound move together. A still
 *   picture is one frame of video, shown as a freeze frame (`STILL_US` long, then trimmed to
 *   taste).
 * - An extra take keeps its own tracks and clips (its edits too), on new tracks.
 * Video tracks go just above the first screen track (under the face overlay); audio tracks go
 * last. Every track, clip and link gets a new ID.
 */
import type { Us } from '../time';
import type { AudioTrack, Clip, Media, Track, VideoTrack } from './schema';

/** Length a still picture is placed with. */
export const STILL_US = 5_000_000;

/** What the importer reports per file it put into the project. */
export interface ImportedMedia {
  mediaId: string;
  kind: 'video' | 'audio';
  still: boolean;
  durationUs: Us;
}

/**
 * The tracks of one imported file (its picture and/or sound), clips from 0, linked. `tag` keeps
 * the placeholder IDs of different files apart (`addMedia` replaces them).
 */
export function importedTracks(name: string, items: readonly ImportedMedia[], tag = '0'): Track[] {
  const linked = items.length > 1 ? `lnk_import${tag}` : null;
  return items.map((item, i): Track => {
    const clip: Clip = item.still
      ? {
          id: `clp_import${tag}x${String(i)}`,
          mediaId: item.mediaId,
          timelineStartUs: 0,
          sourceStartUs: 0,
          sourceEndUs: item.durationUs,
          linkId: linked,
          freeze: true,
          durationUs: STILL_US,
        }
      : {
          id: `clp_import${tag}x${String(i)}`,
          mediaId: item.mediaId,
          timelineStartUs: 0,
          sourceStartUs: 0,
          sourceEndUs: item.durationUs,
          linkId: linked,
        };
    const base = {
      id: `trk_import${tag}x${String(i)}`,
      name,
      componentId: null,
      locked: false,
      clips: [clip],
    };
    if (item.kind === 'video') {
      const video: VideoTrack = {
        ...base,
        type: 'video',
        hidden: false,
        layout: { kind: 'screen', crop: null, fit: 'contain' },
      };
      return video;
    }
    const audio: AudioTrack = { ...base, type: 'audio', gainDb: 0, muted: false, solo: false };
    return audio;
  });
}

/** Videos larger than 1080p get a preview proxy (acceptance g). */
export function needsProxy(video: { width: number; height: number }): boolean {
  return video.width * video.height > 1920 * 1080;
}

/** A media entry for an imported file (its own clock: reference time = file time). */
export function importedMediaEntry(
  id: string,
  relativePath: string,
  file: {
    kind: 'video' | 'audio';
    durationUs: Us;
    video?: { codec: string; width: number; height: number; frameRateNominal: number };
    audio?: { codec: string; sampleRate: number; channels: number };
  },
): Media {
  return {
    id,
    role: 'imported',
    kind: file.kind,
    path: relativePath,
    status: 'ok',
    durationUs: file.durationUs,
    startOffsetUs: 0,
    syncAdjustUs: 0,
    clockRatio: 1,
    ...(file.kind === 'video' && file.video
      ? { video: { ...file.video, variableFrameRate: false } }
      : {}),
    ...(file.kind === 'audio' && file.audio
      ? { audio: { ...file.audio, discontinuities: 0 } }
      : {}),
  };
}
