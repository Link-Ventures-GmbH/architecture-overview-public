#!/usr/bin/env node
// arch-overview [path] [--workspace dir] [--port 8360] [--otlp-port 4318] [--host 127.0.0.1] [--no-open]

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { start } from '../src/server.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

if (args.includes('-h') || args.includes('--help')) {
  console.log(`
  Link Labs · Architecture Overview

  usage   arch-overview [path] [--workspace dir] [--port 8360] [--otlp-port 4318] [--host 127.0.0.1] [--no-open]

  Scans the repo at [path] (default: current folder), opens a live map in your
  browser and follows every save and commit while you code. Point your app's
  OpenTelemetry exporter at http://localhost:4318 to see it running.
  --workspace (default: the folder above [path]) lists the other projects to switch to.
`);
  process.exit(0);
}

const port = Number(flag('--port', process.env.PORT || 8360));
const host = flag('--host', process.env.HOST || '127.0.0.1');
const otlpPort = Number(flag('--otlp-port', process.env.OTLP_PORT || 4318));
const workspaceArg = flag('--workspace', process.env.AO_WORKSPACE || null);
const noOpen = args.includes('--no-open');
const root = path.resolve(args.filter((a) => !a.startsWith('--'))[0] || '.');

if (!existsSync(root)) {
  console.error(`  no such folder: ${root}`);
  process.exit(1);
}

console.log(`\n  LINK LABS · Architecture Overview\n  watching ${root}`);

try {
  const workspace = workspaceArg ? path.resolve(workspaceArg) : path.dirname(root);
  const { url } = await start({ root, workspace, port, host, otlpPort });
  console.log(`  live at  ${url}\n`);
  if (!noOpen) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(cmd, [url], () => {});
  }
} catch (e) {
  if (e.code === 'EADDRINUSE') console.error(`  port ${port} is taken. Try --port ${port + 1}`);
  else console.error(e);
  process.exit(1);
}
