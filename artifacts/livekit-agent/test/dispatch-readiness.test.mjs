import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/process-readiness.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {ProcessReadiness}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
test('ambiguous dispatch retires once, cannot re-register or claim, replacement restores readiness',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const live=new Set([10,11]),retired=[];
 const p=new ProcessReadiness(pid=>live.has(pid),pid=>retired.push(pid));
 p.register(10);assert.equal(p.reserve('a'),true);const entry=p.waitForEntry('a');
 for(let i=0;i<20;i++)assert.equal(p.available(),false);
 assert.equal(p.register(10),false);assert.equal(p.enter('a',11),false);
 p.dispatched('a');t.mock.timers.tick(7500);assert.equal(await entry,false);assert.deepEqual(retired,[10]);
 p.fail('a');p.close();assert.deepEqual(retired,[10]);assert.equal(p.enter('a',10),false);
 live.delete(10);assert.equal(p.register(11),true);assert.equal(p.available(),true);
});
test('confirmed child entry clears deadline; receipt is single-use and shutdown is idempotent',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const retired=[];
 const p=new ProcessReadiness(()=>true,pid=>retired.push(pid));p.register(10);p.reserve('a');
 const receipt=p.waitForEntry('a');assert.equal(p.enter('a',10),true);assert.equal(await receipt,true);
 p.complete('a');t.mock.timers.tick(15000);assert.deepEqual(retired,[]);assert.equal(p.enter('a',10),false);
 assert.equal(p.register(10),false);assert.equal(p.available(),false);p.close();p.close();
});
test('assignment exception and dead idle child recover without reusing consumed capacity',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const live=new Set([10,11,12]),retired=[];
 const p=new ProcessReadiness(pid=>live.has(pid),pid=>retired.push(pid));p.register(10);live.delete(10);assert.equal(p.available(),false);
 p.register(11);p.reserve('b');const receipt=p.waitForEntry('b');p.fail('b');assert.equal(await receipt,false);assert.deepEqual(retired,[11]);
 p.register(12);assert.equal(p.available(),true);p.reserve('c');const last=p.waitForEntry('c');p.close();assert.equal(await last,false);assert.deepEqual(retired,[11,12]);
});
