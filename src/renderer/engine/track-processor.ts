/**
 * `MediaStreamTrackProcessor` (Chromium's insertable streams, exposed on `Window` in Electron):
 * turns a track into a `ReadableStream` of `VideoFrame`s or `AudioData`, which the engine
 * transfers to a pipeline worker. The DOM lib does not declare it on `Window`, hence this helper.
 */
type TrackProcessorConstructor = new (init: {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}) => { readable: ReadableStream<VideoFrame | AudioData> };

function processorConstructor(): TrackProcessorConstructor {
  const ctor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorConstructor })
    .MediaStreamTrackProcessor;
  if (!ctor) throw new Error('MediaStreamTrackProcessor is not available');
  return ctor;
}

export function videoFrames(track: MediaStreamTrack): ReadableStream<VideoFrame> {
  const Processor = processorConstructor();
  return new Processor({ track }).readable as ReadableStream<VideoFrame>;
}

export function audioChunks(track: MediaStreamTrack): ReadableStream<AudioData> {
  const Processor = processorConstructor();
  return new Processor({ track }).readable as ReadableStream<AudioData>;
}
