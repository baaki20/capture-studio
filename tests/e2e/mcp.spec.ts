/**
 * The MCP server end to end: an MCP client (as Claude Code uses) starts `src/mcp/server.ts` over
 * stdio, pointed at the real app's automation socket, and edits a synthetic project with tool
 * calls: trim the start, move the face, remove the pause, undo and redo, look at a frame, and
 * export, checking the result in the editor and with ffprobe.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { _electron as electron, expect, test } from '@playwright/test';
import { timelineDurationUs } from '../../src/shared/project/timeline-ops';
import {
  ROOT,
  S,
  SECONDS,
  launchOptions,
  makeProject,
  probeDurationSec,
  writeAutomationSettings,
} from './automation-fixture';

interface ToolReply {
  isError: boolean;
  text: string;
  content: { type: string; text?: string; data?: string }[];
}

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('an assistant edits and exports a project through the MCP server', async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-mcp-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-mcp-projects-'));
  writeAutomationSettings(userData, projects);
  const doc = makeProject(projects);
  const app = await electron.launch(launchOptions(userData));
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  try {
    await app.firstWindow();
    await client.connect(
      new StdioClientTransport({
        command: path.join(ROOT, 'node_modules/.bin/tsx'),
        args: [path.join(ROOT, 'src/mcp/server.ts')],
        cwd: ROOT,
        env: {
          ...(process.env as Record<string, string>),
          CS_AUTOMATION_SOCKET: path.join(userData, 'automation', 'automation.sock'),
        },
        stderr: 'pipe',
      }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as ToolReply['content'];
      return {
        isError: result.isError === true,
        text: content.map((c) => c.text ?? '').join('\n'),
        content,
      };
    };
    const editor = () => app.windows().find((w) => w.url().includes('editor/index.html'));
    const liveDoc = async () => {
      const page = editor();
      if (!page) throw new Error('no editor window');
      const current = await page.evaluate(() => window.csEditorDebug?.doc() ?? null);
      if (!current) throw new Error('the editor has no document');
      return current;
    };

    expect(client.getInstructions()).toContain('apply_edits');
    // The app may still be starting its socket.
    await expect
      .poll(async () => (await call('list_projects')).text, { timeout: 30_000 })
      .toContain(doc.id);

    const project = (await call('get_project', { project: 'Lesson test' })).text;
    expect(JSON.parse(project)).toMatchObject({ id: doc.id, openInEditor: false });

    const trimmed = await call('trim_ends', { project: 'Lesson test', startSeconds: 1 });
    expect(trimmed.isError).toBe(false);
    expect(trimmed.text).toMatch(/^Applied "Trim first 1 s"/);
    expect(timelineDurationUs(await liveDoc())).toBe((SECONDS - 1) * S);

    const face = await call('set_face_layout', {
      project: doc.id,
      corner: 'top-left',
      size: 'small',
      shape: 'circle',
    });
    expect(face.text).toContain('Track "Face": layout.width 0.2 → 0.12');
    const faceTrack = (await liveDoc()).timeline.tracks.find((t) => t.name === 'Face');
    expect(faceTrack?.type === 'video' && faceTrack.layout).toMatchObject({
      kind: 'overlay',
      width: 0.12,
      shape: 'circle',
    });

    // The pause (2–4 s in the mic, 1–3 s on the timeline after the trim), once peaks exist.
    let removed: ToolReply | null = null;
    await expect
      .poll(
        async () => {
          removed = await call('remove_silences', { project: doc.id, minSeconds: 1 });
          return removed.isError ? removed.text : 'done';
        },
        { timeout: 60_000 },
      )
      .toBe('done');
    expect(removed!.text).toMatch(/^Applied "Remove 1 pause"/);
    const afterPauseUs = timelineDurationUs(await liveDoc());
    expect(afterPauseUs / S).toBeCloseTo(SECONDS - 1 - 1.7, 1);

    expect((await call('undo', { project: doc.id })).text).toMatch(/^Undid "Remove 1 pause"/);
    expect(timelineDurationUs(await liveDoc())).toBe((SECONDS - 1) * S);
    expect((await call('redo', { project: doc.id })).text).toMatch(/^Redid "Remove 1 pause"/);
    expect(timelineDurationUs(await liveDoc())).toBe(afterPauseUs);

    // Frames need the preview's WebGL2 compositor, which plain Xvfb may lack (see automation.spec).
    const frame = await call('get_frame', { project: doc.id, at: 0.5, maxWidth: 320 });
    if (frame.isError) {
      expect(frame.text).toMatch(/preview is not ready/);
      test.info().annotations.push({
        type: 'not run',
        description: 'get_frame: the preview cannot render on this display (no WebGL2)',
      });
    } else {
      expect(frame.content[0]).toMatchObject({ type: 'image' });
    }

    const started = await call('export_project', {
      project: doc.id,
      resolution: '720p',
      fps: 30,
      quality: 'draft',
      encoder: 'software',
    });
    const jobId = /job (job_[0-9A-Za-z]+)/.exec(started.text)?.[1];
    expect(jobId, started.text).toBeTruthy();
    const status = JSON.parse((await call('export_status', { jobId, waitSeconds: 90 })).text) as {
      state: string;
      file: string | null;
    };
    expect(status.state).toBe('done');
    expect(status.file && existsSync(status.file)).toBe(true);
    expect(probeDurationSec(status.file!)).toBeCloseTo(afterPauseUs / S, 0);

    const again = await call('export_project', { project: doc.id, quality: 'draft' });
    expect(again.text).toMatch(/already exists\. Ask the user/);
  } finally {
    await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await test
      .info()
      .attach('main.log', { path: path.join(userData, 'logs', 'main.log') })
      .catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
