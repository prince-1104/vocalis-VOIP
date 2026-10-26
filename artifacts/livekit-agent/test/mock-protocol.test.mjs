import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
const require=createRequire(new URL('../../api-server/package.json',import.meta.url));
const {WebSocket}=require('ws');
test('actual mock STT faults target a live utterance after greeting; noise has no words and a dropped stream recovers',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dialog-mock-protocol-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const source=(await readFile('../../deploy/livekit/mock-providers.mjs','utf8'))
  .replace("const require = createRequire(new URL('../../artifacts/api-server/package.json', import.meta.url));",'')
  .replace("const { WebSocketServer } = require('ws');","import { WebSocketServer } from 'ws';")
  .replace("http.listen(8090, '0.0.0.0');","http.listen(0, '127.0.0.1', () => console.log('MOCKPORT ' + http.address().port));");
 const built=await build({stdin:{contents:source,resolveDir:path.resolve('../api-server'),loader:'js'},bundle:true,write:false,platform:'node',format:'cjs',
  plugins:[{name:'fixture-ws',setup(b){b.onResolve({filter:/^ws$/},()=>({path:require.resolve('ws')}))}}]});
 const file=path.join(directory,'mock.cjs');await writeFile(file,built.outputFiles[0].text);
 const child=spawn(process.execPath,[file],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 const exited=once(child,'exit');
 t.after(async()=>{if(child.exitCode===null)child.kill();await exited});
 const port=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('mock did not start')),10000);
  child.stdout.on('data',x=>{const m=/MOCKPORT (\d+)/.exec(String(x));if(m){clearTimeout(timer);resolve(Number(m[1]))}});
  child.once('error',e=>{clearTimeout(timer);reject(e)});
 });
 const base=`http://127.0.0.1:${port}`,control=async mode=>{
  assert.equal((await fetch(base+'/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'stt',mode,count:1})})).status,200);
 };
 const connect=async()=>{const socket=new WebSocket(`ws://127.0.0.1:${port}/v1/listen?endpointing=25&interim_results=true&sample_rate=16000`);await once(socket,'open');return socket};
 const loud=ms=>{const pcm=Buffer.alloc(ms*16*2);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(1000,i);return pcm};
 const utterance=(socket,ms)=>{socket.send(loud(ms));socket.send(Buffer.alloc(40*16*2))};
 const metrics=()=>fetch(base+'/metrics').then(r=>r.json());
 const socket=await connect(),messages=[];socket.on('message',x=>messages.push(JSON.parse(String(x))));
 t.after(()=>socket.terminate());
 let final=once(socket,'message');utterance(socket,1200);await final;
 const barrier=async()=>{const pong=once(socket,'pong');socket.ping();await pong};await barrier();
 const before=await metrics();assert.equal(before.sttFinals,1);
 await control('noise');const from=messages.length;utterance(socket,250);await barrier();
 assert.equal(messages.slice(from).some(x=>x.type==='Results'),false);
 assert.equal((await metrics()).injectedFailures,1);assert.equal((await metrics()).sttFinals,1);
 await control('drop');const closed=once(socket,'close');utterance(socket,1200);await closed;
 assert.equal((await metrics()).injectedFailures,2);assert.equal((await metrics()).sttFinals,1);
 const replacement=await connect();t.after(()=>replacement.terminate());
 const result=once(replacement,'message');utterance(replacement,1200);await result;
 const pong=once(replacement,'pong');replacement.ping();await pong;
 const after=await metrics();assert.equal(after.sttFinals,2);assert.equal(after.sttConnections,2);assert.equal(after.injectedFailures,2);
});
