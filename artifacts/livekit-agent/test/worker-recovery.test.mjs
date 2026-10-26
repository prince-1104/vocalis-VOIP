import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
const built=await build({entryPoints:['src/worker-recovery.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {superviseInference,observeInferenceExit}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
test('Node spawn observer preserves IPC and records only numeric inference/job exit evidence',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dialog-inference-')),rows=[];
 const observer=observeInferenceExit(fields=>rows.push(fields));
 try{
  for(const [kind,name] of [[0,'inference'],[1,'job']]){
   const file=path.join(directory,`${name}_proc_lazy_main.cjs`);
   await writeFile(file,"process.send({case:'pongResponse'},()=>process.send({case:'inferenceResponse',value:'private-sentinel'},()=>process.exit(7)));");
   const child=fork(file,[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
   const messages=[];child.on('message',m=>messages.push(m));await once(child,'exit');
   assert.equal(messages.at(-1).value,'private-sentinel');assert.equal(rows.at(-1).kind,kind);
   assert.equal(rows.at(-1).exitCode,7);assert.equal(rows.at(-1).pongs,1);assert.equal(rows.at(-1).signal,0);
   assert.ok(Object.values(rows.at(-1)).every(Number.isFinite));
  }
  assert.equal(rows.length,2);assert.doesNotMatch(JSON.stringify(rows),/private-sentinel/);
 }finally{observer.dispose();await rm(directory,{recursive:true,force:true})}
});
test('only confirmed inference death retires the worker, once; concurrent checks never duplicate recovery',async()=>{
 let mode='healthy',restarts=0,release;
 const recovery=superviseInference(async()=>{if(mode==='transport')throw new Error('unavailable');return mode==='dead'},async()=>{restarts++;await new Promise(r=>release=r)});
 try{
  await recovery.check();mode='transport';await recovery.check();assert.equal(restarts,0);
  mode='dead';const first=recovery.check();await Promise.resolve();await recovery.check();assert.equal(restarts,1);
  release();await first;await recovery.check();assert.equal(restarts,1);
 }finally{recovery.dispose()}
});
test('shutdown during an in-flight health probe cannot restart the worker',async()=>{
 let release,restarts=0;
 const recovery=superviseInference(()=>new Promise(r=>release=r),async()=>{restarts++});
 const pending=recovery.check();recovery.dispose();release(true);await pending;await recovery.check();assert.equal(restarts,0);
});
