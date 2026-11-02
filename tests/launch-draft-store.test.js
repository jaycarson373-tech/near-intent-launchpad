import test from 'node:test';
import assert from 'node:assert/strict';
import {launchDraft} from '../lib/launch-draft-store.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('an unopened or blocked browser database cannot leave preparation spinning indefinitely',async()=>{
 await assert.rejects(launchDraft('get','devnet',null,{storage:{open:()=>({})},timeoutMs:10}),/timed out/);
 const request={};const pending=launchDraft('get','devnet',null,{storage:{open:()=>request},timeoutMs:50});await delay(1);request.onblocked();await assert.rejects(pending,/storage is busy/);
});
test('a database opened after timeout is closed rather than leaking a recovery lock',async()=>{
 const request={};let closed=0;const pending=launchDraft('get','devnet',null,{storage:{open:()=>request},timeoutMs:10});await assert.rejects(pending,/timed out/);request.result={close:()=>closed++};request.onsuccess();assert.equal(closed,1);
});
test('stalled draft commits abort, release the database and fail before wallet approval',async()=>{
 const request={};let aborted=0,closed=0;const db={close:()=>closed++,transaction:()=>({abort:()=>aborted++,objectStore:()=>({put:()=>({})})})};
 const p=launchDraft('put','devnet',{name:'coin'},{storage:{open:()=>request},timeoutMs:10});request.result=db;queueMicrotask(()=>request.onsuccess());await assert.rejects(p,/timed out/);assert.equal(aborted,1);assert.equal(closed,1);
});
test('successful draft storage settles only after the transaction commits',async()=>{
 const request={},tx={objectStore:()=>({put:()=>({result:'saved'})})};let closed=0;
 const p=launchDraft('put','devnet',{name:'coin'},{storage:{open:()=>request},timeoutMs:100});request.result={close:()=>closed++,transaction:()=>tx};queueMicrotask(()=>request.onsuccess());await delay(1);tx.oncomplete();assert.equal(await p,'saved');assert.equal(closed,1);
});
