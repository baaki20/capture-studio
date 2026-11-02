/**
 * The Capture Studio MCP server: lets an AI assistant (Claude Code, Claude Desktop, …) edit and
 * export projects in the running app with natural language. It speaks MCP over stdio and talks
 * to the app over its automation socket, which the user turns on in Settings → Assistants.
 *
 * Run: `npm run mcp` (or `tsx src/mcp/server.ts`). `CS_AUTOMATION_SOCKET` points it at a
 * non-default profile's socket. Stdout carries the protocol, so logs go to stderr.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppClient } from './app-client';
import { automationSocketPath } from './socket-path';
import { registerTools, SERVER_INSTRUCTIONS } from './tools';

export const SERVER_NAME = 'capture-studio';
export const SERVER_VERSION = '0.1.0';

export function createServer(app: Parameters<typeof registerTools>[1]): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, app);
  return server;
}

async function main(): Promise<void> {
  const socketPath = automationSocketPath();
  const app = new AppClient({ socketPath });
  const server = createServer(app);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`capture-studio MCP server ready (app socket: ${socketPath})\n`);
  const shutdown = () => {
    app.close();
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}

// Run when started as a program (not when imported by tests). The URL comparison needs proper
// encoding: project paths may contain spaces.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`capture-studio MCP server failed: ${String(error)}\n`);
    process.exit(1);
  });
}
