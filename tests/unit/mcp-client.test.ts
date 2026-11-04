/**
 * The MCP server's socket client against a real automation server; time parsing; the default
 * socket path.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AutomationFailure,
  AutomationServer,
  type AutomationHandlers,
} from '../../src/main/automation/automation-server';
import { AppClient } from '../../src/mcp/app-client';
import { automationSocketPath } from '../../src/mcp/socket-path';
import { toUs } from '../../src/mcp/units';
import { fakeApp } from '../fixtures/automation-app';
import { recordedProject } from '../fixtures/editor-project';

let dir: string;
let server: AutomationServer | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-mcp-client-'));
});

afterEach(async () => {
  await server?.stop();
  server = null;
  await fs.rm(dir, { recursive: true, force: true });
});

async function serve(handlers: AutomationHandlers): Promise<string> {
  const socketPath = path.join(dir, 'automation', 'automation.sock');
  server = new AutomationServer({ socketPath, handlers });
  await server.start();
  return socketPath;
}

describe('AppClient', () => {
  it('connects, says hello and returns validated results', async () => {
    const doc = recordedProject();
    const { service } = fakeApp(doc);
    const client = new AppClient({ socketPath: await serve(service.handlers) });
    const { projects } = await client.call('projects.list', {});
    expect(projects).toEqual([expect.objectContaining({ id: doc.id })]);
    const got = await client.call('project.get', { projectId: doc.id });
    expect(got.doc.id).toBe(doc.id);
    client.close();
  });

  it('retries while the user is dragging, then gives up with the code', async () => {
    const { service } = fakeApp(recordedProject());
    let refusals = 2;
    const handlers: AutomationHandlers = {
      ...service.handlers,
      'project.undo': (params) =>
        refusals-- > 0
          ? Promise.reject(new AutomationFailure('busy', 'dragging'))
          : service.handlers['project.undo'](params),
    };
    const socketPath = await serve(handlers);
    const client = new AppClient({ socketPath, busyRetryMs: [1, 1] });
    const doc = recordedProject();
    expect(await client.call('project.undo', { projectId: doc.id })).toMatchObject({ done: false });
    refusals = 5;
    await expect(client.call('project.undo', { projectId: doc.id })).rejects.toMatchObject({
      code: 'busy',
    });
    client.close();
  });

  it('explains how to turn automation on when nothing listens, and reconnects later', async () => {
    const socketPath = path.join(dir, 'automation', 'automation.sock');
    const client = new AppClient({ socketPath });
    await expect(client.call('projects.list', {})).rejects.toMatchObject({
      code: 'app-unavailable',
      message: expect.stringContaining('Settings → Assistants') as unknown,
    });
    const { service } = fakeApp(recordedProject());
    await serve(service.handlers);
    expect((await client.call('projects.list', {})).projects).toHaveLength(1);
    await server?.stop();
    await expect(client.call('projects.list', {})).rejects.toMatchObject({
      code: 'app-unavailable',
    });
    client.close();
  });
});

describe('MCP time input', () => {
  it('reads seconds, clock times and timecode', () => {
    expect(toUs(12.5, 30)).toBe(12_500_000);
    expect(toUs('12.5', 30)).toBe(12_500_000);
    expect(toUs('12.5s', 30)).toBe(12_500_000);
    expect(toUs('1:02.5', 30)).toBe(62_500_000);
    expect(toUs('1:00:02', 30)).toBe(3_602_000_000);
    expect(toUs('00:00:01:15', 30)).toBe(1_500_000);
    for (const bad of ['soon', '1:75', '-3', '00:00:01:45']) {
      expect(() => toUs(bad, 30), bad).toThrow(/not a time/);
    }
  });
});

describe('socket path', () => {
  it('follows the env override, XDG_CONFIG_HOME and the macOS folder', () => {
    expect(automationSocketPath({ CS_AUTOMATION_SOCKET: '/x/a.sock' }, 'linux', '/home/u')).toBe(
      '/x/a.sock',
    );
    expect(automationSocketPath({}, 'linux', '/home/u')).toBe(
      '/home/u/.config/Capture Studio/automation/automation.sock',
    );
    expect(automationSocketPath({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/u')).toBe(
      '/cfg/Capture Studio/automation/automation.sock',
    );
    expect(automationSocketPath({}, 'darwin', '/Users/u')).toBe(
      '/Users/u/Library/Application Support/Capture Studio/automation/automation.sock',
    );
  });
});
