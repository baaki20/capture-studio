/**
 * The Capture Studio MCP tools. Each one reads or changes a project in the running app through
 * the automation socket (`AppApi`). Edits go through `edit()`: read the project and its version,
 * build the operations locally (`edits.ts`), and send them as one undo step guarded by the
 * version, so a change the user makes in between is never overwritten.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AutomationResult } from '../shared/automation/protocol';
import { MAX_AUTOMATION_BATCH_OPS } from '../shared/ipc/editor-automation';
import { summarizeProject, timeSummary } from '../shared/project/summary';
import { formatTimecode, usToSeconds } from '../shared/time';
import type { AppApi } from './app-client';
import { buildBatch, EditStep, SHAPES, type StepKind } from './edits';
import { errorResult, ToolInputError } from './errors';
import { TimeInput, secondsText, toUs } from './units';

export const SERVER_INSTRUCTIONS = `Capture Studio is a screen recorder with a video editor. These tools edit projects in the running app.

- Start with list_projects, then get_project for the timeline: tracks (Screen, Face, Voice, System audio), their clips with IDs and times, and settings. Times are seconds (or "m:ss.s" / "hh:mm:ss:ff").
- Every edit opens the project in the editor, shows there at once, and is one undo step the user can undo with Ctrl+Z (or the undo tool). Reads and dry runs never open a window.
- For several changes in one request, use apply_edits so they land together as one step. Later steps see the timeline earlier steps leave, so times shift after cuts.
- Use dryRun: true to preview large or destructive edits (and tell the user what would change) before applying them.
- Cuts (cut_range, trim_ends, remove_silences) remove time from every unlocked track together, keeping audio and video in sync.
- Edits refuse with "conflict" if the user changed the project since you read it: read it again and redo.
- Exports go to the user's exports folder. Ask the user before overwriting an existing file.
- Not possible yet: zooms, captions, transcripts, text, speed changes, transitions, adding media or tracks.`;

type Result = CallToolResult;

function text(value: string): Result {
  return { content: [{ type: 'text', text: value }] };
}

function json(value: unknown, lead?: string): Result {
  const body = JSON.stringify(value, null, 2);
  return text(lead ? `${lead}\n${body}` : body);
}

async function run(task: () => Promise<Result>): Promise<Result> {
  try {
    return await task();
  } catch (error) {
    return errorResult(error);
  }
}

const ProjectRef = z
  .string()
  .min(1)
  .describe('Project ID (prj_…) or its exact name, from list_projects');
const DryRun = z
  .boolean()
  .optional()
  .describe('Report what would change without changing anything');

/** A project ID from an ID or a (unique) name. */
async function resolveProject(app: AppApi, ref: string): Promise<string> {
  if (/^prj_[0-9A-Za-z]+$/.test(ref)) return ref;
  const { projects } = await app.call('projects.list', {});
  const wanted = ref.trim().toLowerCase();
  const exact = projects.filter((p) => p.name.toLowerCase() === wanted);
  const matches =
    exact.length > 0 ? exact : projects.filter((p) => p.name.toLowerCase().includes(wanted));
  if (matches.length === 1 && matches[0]) return matches[0].id;
  const names = projects.map((p) => `"${p.name}" (${p.id})`).join(', ');
  throw new ToolInputError(
    matches.length > 1
      ? `Several projects match "${ref}": ${matches.map((p) => `"${p.name}" (${p.id})`).join(', ')}. Use the ID.`
      : `No project "${ref}". Projects: ${names || 'none'}.`,
  );
}

async function readProject(app: AppApi, ref: string) {
  const projectId = await resolveProject(app, ref);
  const got = await app.call('project.get', { projectId });
  return { projectId, ...got };
}

function describeEdit(
  label: string,
  result: AutomationResult<'project.edit'>,
  dryRun: boolean,
): string {
  const lines: string[] = [];
  if (dryRun) lines.push(`Dry run of "${label}": nothing was changed. It would do this:`);
  else if (result.applied) lines.push(`Applied "${label}" as one undo step in the editor.`);
  else lines.push(`"${label}" changed nothing.`);
  lines.push(...(result.change.lines.length > 0 ? result.change.lines : ['(no changes)']));
  lines.push(`Project version: ${String(result.version)}`);
  return lines.join('\n');
}

/** Builds, sends and reports an edit. */
async function edit(
  app: AppApi,
  projectRef: string,
  label: string,
  steps: EditStep[],
  dryRun = false,
): Promise<Result> {
  const project = await readProject(app, projectRef);
  if (project.readOnly) {
    throw new ToolInputError(
      'This project opens read-only (made by a newer version of Capture Studio).',
    );
  }
  const ops = buildBatch(project.doc, steps);
  if (ops.length > MAX_AUTOMATION_BATCH_OPS) {
    throw new ToolInputError(
      `That is ${String(ops.length)} operations; at most ${String(MAX_AUTOMATION_BATCH_OPS)} fit in one edit. Split it up.`,
    );
  }
  const result = await app.call('project.edit', {
    projectId: project.projectId,
    label,
    ops,
    dryRun,
    ifVersion: project.version,
  });
  return text(describeEdit(label, result, dryRun));
}

/** A tool for one kind of edit step, taking the step's fields plus project and dryRun. */
function stepTool<K extends StepKind>(
  server: McpServer,
  app: AppApi,
  name: string,
  kind: K,
  description: string,
  label: (step: Extract<EditStep, { kind: K }>) => string,
): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: { project: ProjectRef, ...SHAPES[kind], dryRun: DryRun },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    (args: Record<string, unknown>) =>
      run(() => {
        const { project, dryRun, ...rest } = args;
        const step = EditStep.parse({ kind, ...rest }) as Extract<EditStep, { kind: K }>;
        return edit(app, String(project), label(step), [step], dryRun === true);
      }),
  );
}

function show(t: TimeInput): string {
  return typeof t === 'number' ? `${String(t)} s` : t;
}

export function registerTools(server: McpServer, app: AppApi): void {
  // -------------------------------------------------------------------------------------------
  // Reading

  server.registerTool(
    'list_projects',
    {
      description:
        'Lists the Capture Studio projects: ID, name, length, recording state and whether it is open in the editor.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const { projects } = await app.call('projects.list', {});
        return json(
          projects.map((p) => ({
            id: p.id,
            name: p.name,
            durationSeconds: Math.round(p.durationUs / 1000) / 1000,
            state: p.state,
            openInEditor: p.open,
            createdAt: p.createdAt,
          })),
        );
      }),
  );

  server.registerTool(
    'get_project',
    {
      description:
        'A project’s timeline: canvas, frame rate, duration, In/Out marks, tracks (with their clips, IDs and times in seconds and timecode, audio gain/mute/solo, video visibility and layout) and components for sync nudges. Read it before editing; clip IDs change after splits and cuts.',
      inputSchema: { project: ProjectRef },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ project }) =>
      run(async () => {
        const got = await readProject(app, project);
        return json({
          ...summarizeProject(got.doc),
          version: got.version,
          openInEditor: got.live,
          readOnly: got.readOnly,
        });
      }),
  );

  // -------------------------------------------------------------------------------------------
  // Editing

  stepTool(
    server,
    app,
    'cut_range',
    'cut',
    'Removes a time range from every unlocked track (audio and video stay in sync) and closes the gap.',
    (a) => `Cut ${show(a.start)}–${show(a.end)}`,
  );
  stepTool(
    server,
    app,
    'trim_ends',
    'trimEnds',
    'Removes seconds from the start and/or end of the whole video, e.g. "cut the first 3 seconds and the last 5".',
    (a) =>
      [
        a.startSeconds ? `first ${String(a.startSeconds)} s` : null,
        a.endSeconds ? `last ${String(a.endSeconds)} s` : null,
      ]
        .filter(Boolean)
        .join(' and ')
        .replace(/^/, 'Trim '),
  );
  stepTool(
    server,
    app,
    'split_at',
    'split',
    'Splits clips at a time (every clip under it, or only the given clips), so parts can be deleted or moved.',
    (a) => `Split at ${show(a.at)}`,
  );
  stepTool(
    server,
    app,
    'delete_clips',
    'deleteClips',
    'Deletes clips (with their linked camera/mic clips by default). ripple: true also closes the gap on every unlocked track.',
    (a) => (a.ripple ? 'Ripple delete' : 'Delete clips'),
  );
  stepTool(
    server,
    app,
    'trim_clip',
    'trimClip',
    'Moves the start or end edge of a clip (and its linked clips). Limited by the media and neighbouring clips; the result reports where it ended up.',
    (a) => `Trim clip ${a.edge}`,
  );
  stepTool(
    server,
    app,
    'move_clip',
    'moveClip',
    'Moves a clip (and its linked clips) to a new start time on the same track.',
    (a) => `Move clip to ${show(a.toStart)}`,
  );
  stepTool(
    server,
    app,
    'set_track',
    'track',
    'Changes a track: volume (gainDb), mute, solo, hide, lock.',
    (a) => `Change ${a.track}`,
  );
  stepTool(
    server,
    app,
    'set_face_layout',
    'faceLayout',
    'Places and styles the camera overlay for the whole video: corner preset, size preset (small/medium/large), or exact centre and width; shape (rectangle/rounded/circle), corner radius, mirror, zoom inside the shape, border and drop shadow. It always stays inside the frame. With layout keyframes it changes every keyframe; use set_face_mode or set_face_keyframe for changes over time.',
    () => 'Change face layout',
  );
  stepTool(
    server,
    app,
    'set_face_mode',
    'faceMode',
    'Shows the face differently for part of the video: full screen, side by side with the screen, hidden, or the normal overlay, from start to end, with an optional eased transition. Afterwards the face returns to what it was.',
    (a) => `Face ${a.mode} ${show(a.start)}–${show(a.end)}`,
  );
  stepTool(
    server,
    app,
    'set_face_keyframe',
    'faceKeyframe',
    'Sets or removes a face layout keyframe at a time: its mode, overlay position or width, and the easing to the next keyframe. get_project lists the keyframes.',
    (a) => (a.remove ? `Remove face keyframe at ${show(a.at)}` : `Face keyframe at ${show(a.at)}`),
  );
  stepTool(
    server,
    app,
    'set_background',
    'background',
    'Styles the screen for the whole video: a colour or gradient background around it, padding, rounded corners and a drop shadow (fractions of the canvas short side). Starts from a default style when the background is plain; off: true goes back to the plain canvas.',
    (a) => (a.off ? 'Plain background' : 'Change background'),
  );
  stepTool(
    server,
    app,
    'zoom_screen',
    'zoom',
    'Zooms the picture (screen and annotations, not the face overlay) into part of the frame from start to end, e.g. to show a detail: zoom 2 shows a quarter of the frame centred on centerX/centerY (fractions). Eased in and out; afterwards the camera returns to what it showed.',
    (a) => `Zoom ${String(a.zoom)}× ${show(a.start)}–${show(a.end)}`,
  );
  stepTool(
    server,
    app,
    'set_zoom_keyframe',
    'zoomKeyframe',
    'Sets or removes a camera zoom keyframe at a time: zoom (1–4), centre (fractions) and the easing to the next keyframe. get_project lists the keyframes.',
    (a) => (a.remove ? `Remove zoom keyframe at ${show(a.at)}` : `Zoom keyframe at ${show(a.at)}`),
  );
  stepTool(
    server,
    app,
    'set_clip_audio',
    'clipAudio',
    'Sets audio clips’ own gain (on top of the track volume) and fade in/out.',
    () => 'Change clip audio',
  );
  stepTool(
    server,
    app,
    'set_volume_keyframe',
    'volumeKeyframe',
    'Sets or removes a volume keyframe of an audio track: dB from that time, eased to the next keyframe (two keyframes make a fade). get_project lists them.',
    (a) =>
      a.remove ? `Remove volume keyframe at ${show(a.at)}` : `Volume keyframe at ${show(a.at)}`,
  );
  stepTool(
    server,
    app,
    'set_audio_cleanup',
    'audioCleanup',
    'Audio cleanup for a track: noise reduction, loudness normalization of the export (−16 LUFS), and ducking (go quieter under a voice track while it speaks).',
    (a) => `Audio cleanup ${a.track}`,
  );
  stepTool(
    server,
    app,
    'set_speed',
    'speed',
    'Plays a time range faster or slower (0.25–4×) on every unlocked track, so face, voice and screen stay in sync; audio keeps its pitch. Everything after the range moves with it.',
    (a) => `Speed ${String(a.speed)}× ${show(a.start)}–${show(a.end)}`,
  );
  stepTool(
    server,
    app,
    'freeze_frame',
    'freezeFrame',
    'Holds the picture at a time for some seconds (audio is silent meanwhile); everything after moves later by that much.',
    (a) => `Freeze ${String(a.seconds)} s at ${show(a.at)}`,
  );
  stepTool(
    server,
    app,
    'set_transition',
    'transition',
    'Sets the transition into a video clip from the clip before it: dissolve, fade-color (through a colour) or slide; none removes it.',
    (a) => (a.type === 'none' ? 'Remove transition' : `Transition ${a.type}`),
  );
  stepTool(
    server,
    app,
    'set_marker',
    'marker',
    'Adds a marker at a time (or changes one by id): a label, and chapter: true to make it a chapter of the exported MP4.',
    (a) => (a.id ? `Change marker ${a.id}` : `Marker at ${show(a.at ?? 0)}`),
  );
  stepTool(
    server,
    app,
    'remove_marker',
    'markerRemove',
    'Removes a marker by id.',
    (a) => `Remove marker ${a.id}`,
  );
  stepTool(
    server,
    app,
    'add_annotation',
    'annotation',
    'Adds an annotation over the video from start to end: text (titles, captions, labels, code), a callout (arrow, rectangle, ellipse, numbered step, highlight, spotlight) or a privacy region (blur, pixelate) to hide something. Boxes are fractions of the frame. get_project lists annotations with their IDs.',
    (a) => `Add ${a.type} at ${show(a.start)}`,
  );
  stepTool(
    server,
    app,
    'edit_annotation',
    'annotationEdit',
    'Changes an annotation: its times, box, text, style preset, colour, step number, strength or fades; moveTo makes it glide to a box by a time (e.g. a blur that follows a moving window).',
    (a) => `Edit annotation ${a.id}`,
  );
  stepTool(
    server,
    app,
    'remove_annotations',
    'annotationRemove',
    'Removes annotations by ID.',
    (a) => `Remove ${String(a.ids.length)} annotation${a.ids.length === 1 ? '' : 's'}`,
  );
  stepTool(
    server,
    app,
    'set_screen_crop',
    'screenCrop',
    'Crops the screen recording to a rectangle in its own pixels, or removes the crop (null).',
    (a) => (a.crop ? 'Crop screen' : 'Remove screen crop'),
  );
  stepTool(
    server,
    app,
    'nudge_sync',
    'syncNudge',
    'Fixes audio/video sync: sets how far a component (face-voice = camera + mic, system-audio, screen) is shifted, in ms (absolute, ±2000).',
    (a) => `Sync nudge ${a.component} ${String(a.offsetMs)} ms`,
  );
  stepTool(
    server,
    app,
    'set_marks',
    'marks',
    'Sets or clears the In/Out marks.',
    () => 'Set marks',
  );

  server.registerTool(
    'apply_edits',
    {
      description:
        'Applies several edits together as ONE undo step, all or nothing. Steps run in order and each sees the timeline the earlier ones left. Step kinds: cut, trimEnds, split, deleteClips, trimClip, moveClip, track, faceLayout, faceMode, faceKeyframe, screenCrop, syncNudge, marks (same fields as the single tools).',
      inputSchema: {
        project: ProjectRef,
        label: z
          .string()
          .min(1)
          .max(100)
          .describe('What the user asked for; shown as the undo step, e.g. "Tidy the intro"'),
        steps: z.array(EditStep).min(1).max(50),
        dryRun: DryRun,
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ project, label, steps, dryRun }) => run(() => edit(app, project, label, steps, dryRun)),
  );

  // -------------------------------------------------------------------------------------------
  // Pauses

  const silenceShape = {
    project: ProjectRef,
    minSeconds: z
      .number()
      .min(0.1)
      .max(600)
      .optional()
      .describe('Shortest pause to count; default 1'),
    thresholdDb: z
      .number()
      .min(-90)
      .max(0)
      .optional()
      .describe('Quieter than this counts as silence, in dBFS; default −45'),
    padSeconds: z
      .number()
      .min(0)
      .max(5)
      .optional()
      .describe('Silence kept next to speech on each side; default 0.15'),
  };
  const findSilences = async (args: {
    project: string;
    minSeconds?: number | undefined;
    thresholdDb?: number | undefined;
    padSeconds?: number | undefined;
  }) => {
    const projectId = await resolveProject(app, args.project);
    const found = await app.call('audio.silences', {
      projectId,
      thresholdDb: args.thresholdDb ?? -45,
      minDurationUs: Math.round((args.minSeconds ?? 1) * 1e6),
      padUs: Math.round((args.padSeconds ?? 0.15) * 1e6),
    });
    const got = await app.call('project.get', { projectId });
    return { projectId, found, frameRate: got.doc.timeline.frameRate };
  };

  server.registerTool(
    'find_silences',
    {
      description:
        'Finds pauses: stretches where every audible audio track (mic and system audio) is quiet. Uses the waveform data the app computes after recording.',
      inputSchema: silenceShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const { found, frameRate } = await findSilences(args);
        const total = found.ranges.reduce((sum, r) => sum + r.endUs - r.startUs, 0);
        return json(
          {
            pauses: found.ranges.map((r) => ({
              start: timeSummary(r.startUs, frameRate),
              end: timeSummary(r.endUs, frameRate),
              seconds: usToSeconds(r.endUs - r.startUs),
            })),
            totalSeconds: usToSeconds(total),
            ...(found.missingMediaIds.length > 0
              ? { note: 'Some audio has no waveform data; its clips were treated as sound.' }
              : {}),
          },
          `${String(found.ranges.length)} pause(s), ${secondsText(total)} in total.`,
        );
      }),
  );

  server.registerTool(
    'remove_silences',
    {
      description:
        'Finds pauses (like find_silences) and cuts them all as one undo step, keeping audio and video in sync. Use dryRun first on long recordings.',
      inputSchema: { ...silenceShape, dryRun: DryRun },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const { projectId, found } = await findSilences(args);
        if (found.ranges.length === 0) return text('No pauses found; nothing was cut.');
        let ranges = found.ranges;
        let note = '';
        if (ranges.length > MAX_AUTOMATION_BATCH_OPS) {
          ranges = [...ranges]
            .sort((a, b) => b.endUs - b.startUs - (a.endUs - a.startUs))
            .slice(0, MAX_AUTOMATION_BATCH_OPS);
          note = `\nOnly the ${String(MAX_AUTOMATION_BATCH_OPS)} longest of ${String(found.ranges.length)} pauses were included; run it again for the rest.`;
        }
        // Latest first, so earlier ranges keep their times.
        const ops = [...ranges]
          .sort((a, b) => b.startUs - a.startUs)
          .map((r) => ({ type: 'cutRange' as const, inUs: r.startUs, outUs: r.endUs }));
        const label = `Remove ${String(ranges.length)} pause${ranges.length === 1 ? '' : 's'}`;
        const result = await app.call('project.edit', {
          projectId,
          label,
          ops,
          dryRun: args.dryRun ?? false,
          ifVersion: found.version,
        });
        return text(describeEdit(label, result, args.dryRun ?? false) + note);
      }),
  );

  // -------------------------------------------------------------------------------------------
  // History

  for (const direction of ['undo', 'redo'] as const) {
    server.registerTool(
      direction,
      {
        description:
          direction === 'undo'
            ? 'Undoes the most recent step in the project’s editor, whoever made it (you or the user). Reports what was undone.'
            : 'Redoes the most recently undone step in the project’s editor.',
        inputSchema: { project: ProjectRef },
        annotations: { destructiveHint: false, openWorldHint: false },
      },
      ({ project }) =>
        run(async () => {
          const projectId = await resolveProject(app, project);
          const result = await app.call(`project.${direction}`, { projectId });
          if (!result.done) return text(`Nothing to ${direction}.`);
          return text(
            [
              `${direction === 'undo' ? 'Undid' : 'Redid'} "${result.label ?? 'edit'}".`,
              ...result.change.lines,
            ].join('\n'),
          );
        }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Looking

  server.registerTool(
    'get_frame',
    {
      description:
        'A picture of the composed video at a time (screen, face overlay and layout as the export will show them), to check a layout or find a moment.',
      inputSchema: {
        project: ProjectRef,
        at: TimeInput,
        maxWidth: z.int().min(64).max(1920).optional().describe('Default 960 px'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ project, at, maxWidth }) =>
      run(async () => {
        const got = await readProject(app, project);
        const atUs = toUs(at, got.doc.timeline.frameRate);
        const frame = await app.call('preview.frame', {
          projectId: got.projectId,
          atUs,
          maxWidth: maxWidth ?? 960,
        });
        return {
          content: [
            { type: 'image', data: frame.pngBase64, mimeType: 'image/png' },
            {
              type: 'text',
              text: `Frame at ${formatTimecode(frame.atUs, got.doc.timeline.frameRate)} (${String(frame.width)}×${String(frame.height)}).`,
            },
          ],
        };
      }),
  );

  // -------------------------------------------------------------------------------------------
  // Exporting

  server.registerTool(
    'export_project',
    {
      description:
        'Exports the project (as the editor shows it) to an MP4 in the user’s exports folder. Returns a job ID; follow it with export_status. If the file exists, ask the user before calling again with overwrite: true.',
      inputSchema: {
        project: ProjectRef,
        resolution: z.enum(['canvas', '1080p', '720p']).optional().describe('Default 1080p'),
        fps: z
          .union([z.literal(30), z.literal(60), z.literal('project')])
          .optional()
          .describe('Default: the project’s'),
        quality: z.enum(['draft', 'standard', 'high']).optional().describe('Default standard'),
        encoder: z
          .enum(['auto', 'software'])
          .optional()
          .describe('Default auto (hardware when available)'),
        overwrite: z.boolean().optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const projectId = await resolveProject(app, args.project);
        const result = await app.call('export.start', {
          projectId,
          options: {
            resolution: args.resolution ?? '1080p',
            fps: args.fps ?? 'project',
            quality: args.quality ?? 'standard',
            encoder: args.encoder ?? 'auto',
          },
          ...(args.overwrite ? { overwrite: true } : {}),
        });
        switch (result.status) {
          case 'started':
            return text(
              `Export started: job ${String(result.jobId)}, writing ${result.path}. Check it with export_status.`,
            );
          case 'exists':
            return text(
              `${result.path} already exists. Ask the user whether to replace it, then call export_project again with overwrite: true.`,
            );
          case 'blocked':
            return {
              ...text(`The export could not start: ${result.message ?? 'blocked'}`),
              isError: true,
            };
        }
      }),
  );

  server.registerTool(
    'export_status',
    {
      description:
        'Progress of an export: running (with fraction and seconds left), done (with the file), failed or cancelled. waitSeconds waits for it to finish, up to that long.',
      inputSchema: {
        jobId: z.string().min(1),
        waitSeconds: z.number().min(0).max(120).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ jobId, waitSeconds }) =>
      run(async () => {
        const end = Date.now() + (waitSeconds ?? 0) * 1000;
        let status = await app.call('export.status', { jobId });
        while (status.state === 'running' && Date.now() < end) {
          await new Promise((r) => setTimeout(r, 1000));
          status = await app.call('export.status', { jobId });
        }
        return json({
          state: status.state,
          percent: Math.round(status.fraction * 100),
          secondsLeft: status.etaSec === null ? null : Math.round(status.etaSec),
          file: status.state === 'done' ? status.outputPath : null,
          message: status.message,
        });
      }),
  );

  server.registerTool(
    'cancel_export',
    {
      description: 'Cancels a running export.',
      inputSchema: { jobId: z.string().min(1) },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ jobId }) =>
      run(async () => {
        const { cancelled } = await app.call('export.cancel', { jobId });
        return text(cancelled ? 'Export cancelled.' : 'That export is not running.');
      }),
  );
}
