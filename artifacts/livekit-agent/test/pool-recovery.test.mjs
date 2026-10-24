import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';

// Execute the installed pool implementation, replacing only OS processes and its queue.
const require = createRequire(import.meta.url);
const entry = path.join(path.dirname(require.resolve('@livekit/agents')), 'ipc/proc_pool.js');
const built = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'controlled-processes', setup(build) {
    build.onResolve({ filter: /job_proc_executor\.js$/ }, () => ({ path: 'executor', namespace: 'controlled' }));
    build.onResolve({ filter: /utils\.js$/ }, () => ({ path: 'queue', namespace: 'controlled' }));
    build.onLoad({ filter: /.*/, namespace: 'controlled' }, args => ({ contents: args.path === 'executor'
      ? 'export const JobProcExecutor = globalThis.__poolExecutor;'
      : 'export class Queue { items = []; async put(item) { this.items.push(item); } async get() { return this.items.shift(); } }', loader: 'js' }));
  } }] });

test('dead queued process releases its slot and is never dispatched; consumed slot releases once', async () => {
  const instances = [];
  globalThis.__poolExecutor = class {
    constructor() { instances.push(this); this.joined = new Promise(resolve => { this.exit = resolve; }); }
    async start() {}
    async initialize() {}
    async join() { await this.joined; }
    async launchJob() { this.launched = true; }
  };
  const { ProcPool } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
  const pool = new ProcPool({ agent: 'fixture', numIdleProcesses: 1, initializeTimeout: 1000, closeTimeout: 1000, memoryWarnMB: 0, memoryLimitMB: 0 });
  let released = 0;
  const first = pool.procWatchTask(() => released++);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pool.warmedProcQueue.items.length, 1);
  instances[0].exit(); await first;
  assert.equal(released, 1, 'a dead idle process must free capacity for replacement');
  assert.equal(pool.warmedProcQueue.items.length, 0, 'dead process must leave the dispatch queue');
  const next = pool.procWatchTask(() => released++);
  await new Promise(resolve => setImmediate(resolve));
  await pool.launchJob({});
  assert.equal(instances[1].launched, true);
  assert.equal(released, 2);
  instances[1].exit(); await next;
  assert.equal(released, 2, 'job exit must not release an already consumed slot again');
  delete globalThis.__poolExecutor;
});
