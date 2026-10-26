import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Execute the installed pool implementation, replacing only OS processes and its queue.
const require = createRequire(import.meta.url);
const entry = path.join(path.dirname(require.resolve('@livekit/agents')), 'ipc/proc_pool.js');
test('installed queue cancellation never consumes a replacement process',async()=>{
 const {Queue}=await import(pathToFileURL(path.join(path.dirname(require.resolve('@livekit/agents')),'utils.js')).href);
 const queue=new Queue(),abort=new AbortController();
 const pending=queue.get({signal:abort.signal});abort.abort();await assert.rejects(pending);
 const replacement={pid:42};await queue.put(replacement);
 await assert.rejects(queue.get({signal:abort.signal}));
 assert.equal(await queue.get(),replacement);assert.equal(queue.items.length,0);
});
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
    isAlive = true;
    constructor() { instances.push(this); this.joined = new Promise(resolve => { this.exit = resolve; }); }
    async start() {}
    async initialize() {}
    async join() { await this.joined; }
    async launchJob() { this.launched = true; }
    async close() { this.isAlive = false; this.exit(); }
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

for (const reason of ['dead-before-assignment', 'send-throws']) {
 test(`installed pool reconciles ${reason} and replacement can dispatch`, async () => {
  const instances=[]; let released=0;
  globalThis.__poolExecutor=class {
   isAlive=true; closes=0;
   constructor(){instances.push(this);this.joined=new Promise(r=>this.exit=r)}
   async start(){} async initialize(){} async join(){await this.joined}
   async launchJob(){if(this.fail)throw new Error('controlled IPC failure');this.launched=true}
   async close(){this.closes++;this.isAlive=false;this.exit()}
  };
  const {ProcPool}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64')+'#'+reason);
  const pool=new ProcPool({agent:'fixture',numIdleProcesses:1,initializeTimeout:1000,closeTimeout:1000,memoryWarnMB:0,memoryLimitMB:0});
  const first=pool.procWatchTask(()=>released++);await new Promise(r=>setImmediate(r));
  instances[0].isAlive=reason!=='dead-before-assignment';instances[0].fail=true;
  await assert.rejects(pool.launchJob({}));await first;
  assert.equal(instances[0].closes,1);assert.equal(released,1);assert.equal(pool.executors.length,0);
  const replacement=pool.procWatchTask(()=>released++);await new Promise(r=>setImmediate(r));
  await pool.launchJob({});assert.equal(instances[1].launched,true);
  instances[1].exit();await replacement;assert.equal(released,2);
  delete globalThis.__poolExecutor;
 });
}

test('installed pool loop survives a fork exception and automatically prewarms replacement',async()=>{
 const instances=[];
 globalThis.__poolExecutor=class{
  isAlive=true;
  constructor(){instances.push(this);this.joined=new Promise(r=>this.exit=r)}
  async start(){if(instances.length===1)throw new Error('controlled fork exception')}
  async initialize(){} async join(){await this.joined}
  async close(){this.isAlive=false;this.exit()}
 };
 const {ProcPool}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64')+'#fork-failure');
 const pool=new ProcPool({agent:'fixture',numIdleProcesses:1,initializeTimeout:1000,closeTimeout:1000,memoryWarnMB:0,memoryLimitMB:0});
 pool.start();
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 assert.equal(instances.length,2);assert.equal(pool.warmedProcQueue.items.length,1);
 await pool.close();await pool.close();assert.equal(pool.executors.length,0);
 delete globalThis.__poolExecutor;
});
