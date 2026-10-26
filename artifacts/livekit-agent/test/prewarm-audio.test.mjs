import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const directory=await mkdtemp(path.resolve('test/.native-prewarm-'));
let prewarmAudio;
try{
 const file=path.join(directory,'prewarm.mjs');
 await build({entryPoints:['src/prewarm-audio.ts'],outfile:file,bundle:true,packages:'external',platform:'node',format:'esm'});
 ({prewarmAudio}=await import(pathToFileURL(file).href));
}finally{await rm(directory,{recursive:true,force:true})}
test('native readiness requires actual capture and drain before child admission and closes the probe',async()=>{
 const order=[];
 await prewarmAudio(()=>({captureFrame:async frame=>{
  order.push('capture');assert.equal(frame.channels,1);assert.equal(frame.sampleRate,24000);
  assert.equal(frame.samplesPerChannel,2400);assert.ok(frame.data.every(x=>x===0));
 },waitForPlayout:async()=>{order.push('drain')},close:async()=>{order.push('close')}}));
 assert.deepEqual(order,['capture','drain','close']);
});
for(const phase of ['capture','drain'])test(`native ${phase} failure rejects prewarm before readiness and closes resources`,async()=>{
 const error=new Error('controlled native failure');let closed=0;
 await assert.rejects(prewarmAudio(()=>({captureFrame:async()=>{if(phase==='capture')throw error},
  waitForPlayout:async()=>{if(phase==='drain')throw error},close:async()=>{closed++}})),e=>e===error);
 assert.equal(closed,1);
});
