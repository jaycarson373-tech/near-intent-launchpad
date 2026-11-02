import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server.mjs';
test('Railway serves the built app, pinned WASM, API boundaries and health',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'intent-pad-host-test-'));await mkdir(join(dir,'contracts'));await writeFile(join(dir,'index.html'),'<div id="root"></div>');await copyFile(new URL('../public/contracts/fungible-token.wasm',import.meta.url),join(dir,'contracts/fungible-token.wasm'));
 const server=createServer(dir+'/').listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try{
  assert.deepEqual(await (await fetch(base+'/health')).json(),{service:'intent-pad',healthy:true});
  const home=await fetch(base+'/');assert.equal(home.status,200);assert.match(await home.text(),/id="root"/);
  const wasm=await fetch(base+'/contracts/fungible-token.wasm');assert.equal(wasm.status,200);assert.equal(wasm.headers.get('content-type'),'application/wasm');assert.equal((await wasm.arrayBuffer()).byteLength,201480);
  assert.equal((await fetch(base+'/api/near',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/missing')).status,404);
  assert.equal((await fetch(base+'/missing.js')).status,404);
  assert.equal((await fetch(base+'/launch')).status,200);
  assert.equal((await fetch(base+'/coin/any')).status,200);
  assert.equal((await fetch(base+'/api/metadata?id=bad')).status,404);
  assert.equal((await fetch(base+'/api/coin?mint=not-a-public-key')).status,400);
  assert.equal((await fetch(base+'/api/intents')).status,405);
  assert.equal((await fetch(base+'/api/launch?action=prepare',{method:'POST',headers:{origin:'https://unrelated.example','content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/',{method:'POST'})).status,405);
  for(const p of ['/..%2f..%2fpackage.json','/%2e%2e/%2e%2e/package.json','/..%2f..%2f..%2f..%2fwindows%2fwin.ini']){const r=await fetch(base+p);assert.ok(r.status===400||r.status===404,p+' -> '+r.status);assert.doesNotMatch(await r.text(),/"name"\s*:/)}
 }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true})}
});
test('a sibling directory sharing the root prefix is never served',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'intent-pad-sibling-'));await mkdir(join(parent,'site'));await mkdir(join(parent,'site-evil'));await writeFile(join(parent,'site','index.html'),'<div id="root"></div>');await writeFile(join(parent,'site-evil','x.txt'),'EVIL');
 const server=createServer(join(parent,'site')).listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try{for(const p of ['/..%2fsite-evil%2fx.txt','/..%5csite-evil%5cx.txt']){const r=await fetch(base+p);assert.ok(r.status===400||r.status===404,p+' -> '+r.status);assert.doesNotMatch(await r.text(),/EVIL/)}}
 finally{await new Promise(resolve=>server.close(resolve));await rm(parent,{recursive:true})}
});
