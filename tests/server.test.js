import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from '../server.mjs';
test('Railway serves the built app, pinned WASM, API boundaries and health',async()=>{
 const server=createServer().listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try{
  assert.deepEqual(await (await fetch(base+'/health')).json(),{service:'intent-pad',healthy:true});
  const home=await fetch(base+'/');assert.equal(home.status,200);assert.match(await home.text(),/id="root"/);
  const wasm=await fetch(base+'/contracts/fungible-token.wasm');assert.equal(wasm.status,200);assert.equal(wasm.headers.get('content-type'),'application/wasm');assert.equal((await wasm.arrayBuffer()).byteLength,201480);
  assert.equal((await fetch(base+'/api/near',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/missing')).status,404);
  assert.equal((await fetch(base+'/missing.js')).status,404);
  assert.equal((await fetch(base+'/',{method:'POST'})).status,405);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
