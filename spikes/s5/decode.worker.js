const { Input, ALL_FORMATS, BufferSource, VideoSampleSink } = require(require('path').resolve(__dirname, '../../node_modules/mediabunny/dist/bundles/mediabunny.cjs'));
onmessage = async (e) => {
  try {
    const buf = await (await fetch(e.data.url)).arrayBuffer();
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(buf) });
    const vt = await input.getPrimaryVideoTrack(); const at = await input.getPrimaryAudioTrack();
    const sink = new VideoSampleSink(vt); const out = { duration: await input.computeDuration(), video: vt.codec, audio: at && at.codec, seeks: [] };
    for (const t of e.data.times) { const t0 = performance.now(); const s = await sink.getSample(t); out.seeks.push({ want: t, got: s && +s.timestamp.toFixed(4), frame: s && Math.round(s.timestamp * 30), ms: Math.round(performance.now() - t0) }); s && s.close(); }
    postMessage(out);
  } catch (err) { postMessage({ error: String(err && err.stack || err) }); }
};
