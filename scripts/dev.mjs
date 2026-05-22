import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** @type {{ name: string; args: string[]; cwd?: string }[]} */
const services = [
  {
    name: 'shared',
    args: [tsc, '-p', 'packages/shared/tsconfig.json', '--watch'],
  },
  {
    name: 'collector',
    args: [tsx, 'watch', 'services/collector/src/index.ts'],
  },
  {
    name: 'writer',
    args: [tsx, 'watch', 'services/writer/src/index.ts'],
  },
  {
    name: 'mock',
    args: [tsx, 'watch', 'services/mock-mssql-api/src/index.ts'],
  },
  {
    name: 'query',
    args: [tsx, 'watch', 'services/query-api/src/index.ts'],
  },
  {
    name: 'dash',
    args: [join(root, 'apps', 'dashboard', 'server.mjs')],
  },
];

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

function prefixLine(name, line) {
  process.stdout.write(`[${name}] ${line}`);
}

function startService({ name, args, cwd = root }) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);

  child.stdout?.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.length > 0) prefixLine(name, `${line}\n`);
    }
  });
  child.stderr?.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.length > 0) prefixLine(name, `${line}\n`);
    }
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`[${name}] exited (${signal ?? code ?? 0})`);
    const fromSignal = signal === 'SIGINT' || signal === 'SIGTERM';
    shutdown(fromSignal ? 0 : code ?? 1, fromSignal ? 'signal' : 'exit');
  });
}

function shutdown(exitCode = 0, reason = 'signal') {
  if (shuttingDown) return;
  shuttingDown = true;
  const msg =
    reason === 'signal'
      ? '\n[dev] Stopping all services (Ctrl+C)...'
      : '\n[dev] Stopping all services...';
  console.log(msg);
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

for (const service of services) {
  startService(service);
}

console.log('[dev] Running: shared, collector, writer, mock, query, dash (Ctrl+C to stop)');
