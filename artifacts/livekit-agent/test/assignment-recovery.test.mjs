import { test } from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
let {JobRequest}=await import('@livekit/agents');
if(process.env.DIALOG_JOB_BASELINE){
 const original=await readFile(process.env.DIALOG_JOB_BASELINE,'utf8');
 const start=original.indexOf('class JobRequest {'),end=original.indexOf('\nexport {',start);
 JobRequest=new Function(original.slice(start,end)+'; return JobRequest;')();
}
test('public JobRequest.accept awaits actual assignment and propagates its failure',async()=>{
 let resolve,done=false;
 const request=new JobRequest({id:'fixture'},async()=>{},()=>new Promise(r=>resolve=r));
 const work=request.accept().then(()=>{done=true});await Promise.resolve();await Promise.resolve();
 assert.equal(done,false,'accept must not report success before its dispatch callback settles');
 resolve();await work;assert.equal(done,true);
 const error=new Error('controlled startup failure');
 await assert.rejects(new JobRequest({id:'fixture'},async()=>{},async()=>{throw error}).accept(),e=>e===error);
});
const file=path.join(path.dirname(require.resolve('@livekit/agents')),'worker.js');
const source=await readFile(process.env.DIALOG_ASSIGNMENT_BASELINE || file,'utf8');
// Execute the installed callback with controlled transport/process boundaries.
let code=source.slice(source.indexOf('const onAccept = async'),source.indexOf('\n    const req =',source.indexOf('const onAccept = async')));
code=code.replaceAll('this.#','this.').replace('const onAccept = async','return async');
class PendingAssignment { constructor(){this.promise=new Promise(r=>this.resolve=r);} }
function harness(onOffer, launch=async()=>{}) {
 const state={pending:{},opts:{agentName:'fixture',wsURL:'ws://fixture'},procPool:{launchJob:launch},logger:{child(){return this},error(){},warn(){}},id:'worker'};
 state.event={emit(){onOffer(state)}};
 const create=new Function('PendingAssignment','WorkerMessage','ASSIGNMENT_TIMEOUT','ATTRIBUTE_AGENT_NAME','req','msg','receivedAt',code);
 return {state,accept:create.call(state,PendingAssignment,class{constructor(x){Object.assign(this,x)}},7500,'agent',{id:'job'},{job:{id:'job'}},0)};
}
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve()};
test('assignment receipt exists before acceptance is emitted (synchronous assignment)',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let launched=0,finished=false;
 const h=harness(s=>{const p=s.pending.job;if(p){delete s.pending.job;p.resolve({url:'ws://fixture',token:'fixture'})}},async()=>{launched++});
 const work=h.accept({attributes:{}}).then(()=>finished=true,()=>finished=true);await settle();
 assert.equal(finished,true);assert.equal(launched,1);assert.deepEqual(Object.keys(h.state.pending),[]);await work;
});
test('assignment timeout rejects and removes pending receipt; late assignment cannot launch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let failure,launched=0;
 const h=harness(()=>{},async()=>{launched++});h.accept({attributes:{}}).catch(e=>failure=e);
 await settle();t.mock.timers.tick(7500);await settle();
 assert.match(failure?.message??'',/assignment timed out/);assert.deepEqual(Object.keys(h.state.pending),[]);assert.equal(launched,0);
});
test('child launch failure reaches application dispatch cleanup',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const error=new Error('controlled launch failure');
 const h=harness(s=>queueMicrotask(()=>{const p=s.pending.job;delete s.pending.job;p.resolve({token:'fixture'})}),async()=>{throw error});
 await assert.rejects(h.accept({attributes:{}}),e=>e===error);assert.deepEqual(Object.keys(h.state.pending),[]);
});
test('acceptance transport exception removes pending assignment',async()=>{
 const error=new Error('controlled transport failure'),h=harness(()=>{throw error});
 await assert.rejects(h.accept({attributes:{}}),e=>e===error);
 assert.deepEqual(Object.keys(h.state.pending),[]);
});
