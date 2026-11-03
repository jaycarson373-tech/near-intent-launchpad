import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,SystemProgram} from '@solana/web3.js';
import {getTransactionDecoder,getTransactionEncoder} from '@solana/kit';
import {ed25519} from '@noble/curves/ed25519';
import {prepareStaged,submitStaged,statusStaged} from '../server/staged-launch.mjs';
import {compileStagedTransaction,stagedAddresses} from '../lib/staged-launch.mjs';
import {cloutPaymentSignature} from '../lib/launch-signatures.mjs';
import {compileLaunchV1} from '../lib/launch-wire.mjs';

function fixture({phase='setup',buy=false}={}) {
  const creator=Keypair.generate(),mint=Keypair.generate(),recipient=Keypair.generate().publicKey;
  const root={id:crypto.randomUUID(),root:true,flow:'staged-v1',creator:creator.publicKey.toBase58(),mint:mint.publicKey.toBase58(),name:'Test',symbol:'TEST',feeTreasury:recipient.toBase58(),devBuySolRaw:buy?'10000000':'0',devBuyRaw:'0',creatorFeeBps:30,feeAllocationVersion:2};
  const instructions=[SystemProgram.transfer({fromPubkey:creator.publicKey,toPubkey:recipient,lamports:1})];
  const latest={blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100};
  const tx=compileStagedTransaction(root,instructions,latest);
  const decoded=getTransactionDecoder().decode(tx.serialize());
  const wire=Buffer.from(getTransactionEncoder().encode({...decoded,signatures:{...decoded.signatures,[root.creator]:ed25519.sign(decoded.messageBytes,creator.secretKey.subarray(0,32))}})).toString('base64');
  const id=crypto.randomUUID(),slot=`staged/attempts/${root.id}/${phase}/first.json`;
  const d={...root,root:false,id,launchId:root.id,phase,slot,previousId:null,wire:Buffer.from(tx.serialize()).toString('base64'),simulationAddresses:stagedAddresses(root),estimatedSolRaw:'10000',expiresAt:Date.now()+60000,lastValidBlockHeight:100,minimumTokensRaw:'1',atomicSolBuy:false};
  const signature=cloutPaymentSignature(Buffer.from(wire,'base64'));
  const saved={id,wire,signature,createdAt:Date.now(),launchId:root.id,phase,flow:'staged-v1'};
  const state={height:90,chain:null,slot:100,now:Date.now(),sends:[],simulations:0,events:[],receipt:null};
  const data=new Map([['drafts/'+root.id+'.json',root],['drafts/'+id+'.json',d],[slot,d]]);
  if(phase!=='setup') data.set(`staged/completed/${root.id}/setup.json`,{id:crypto.randomUUID(),signature:'setup'});
  if(phase==='buy') data.set(`staged/completed/${root.id}/create.json`,{id:crypto.randomUUID(),signature:'create',coin:{mint:root.mint,signature:'create'}});
  const read=async key=>structuredClone(data.get(key)||null);
  const io={
    read,now:()=>state.now,configured:()=>true,rewards:async()=>({ready:true,treasury:root.feeTreasury}),context:async()=>({rpc:io.rpc}),
    create:async(key,value)=>{if(data.has(key))throw Error('exists');data.set(key,structuredClone(value));},
    createOnce:async(key,value,identity)=>{if(data.has(key)){const old=data.get(key);if(!identity(old,value))throw Error('conflict');return structuredClone(old);}data.set(key,structuredClone(value));return structuredClone(value);},
    checkNetwork:async()=>{},indexPending:async s=>{state.events.push('persisted:'+s.signature);},removePending:async()=>{},
    readReceipt:async()=>state.receipt,
    prepareTransaction:async(r,next)=>({...d,...r,root:false,phase:next,expiresAt:state.now+60000}),
    rpc:{
      getSlot:async()=>100,getBlockHeight:async()=>{state.events.push('height');return state.height;},
      getSignatureStatuses:async()=>{state.events.push('status');return {context:{slot:state.slot},value:[state.chain]};},
      getBalanceAndContext:async()=>({context:{slot:100},value:1000000}),
      simulateTransaction:async()=>{state.simulations++;return {context:{slot:100},value:{err:null,accounts:d.simulationAddresses.map((_,i)=>i===0?{lamports:999999}:null)}};},
      getFeeForMessage:async()=>({value:1}),getAccountInfo:async()=>null,getMultipleAccountsInfo:async keys=>keys.map(()=>null),
      sendRawTransaction:async(bytes,options)=>{assert.equal(data.get('signed/'+id+'.json')?.signature,signature);assert.equal(options.skipPreflight,false);state.sends.push(Buffer.from(bytes).toString('base64'));return signature;},
    },
  };
  const alternate=compileLaunchV1({payer:creator.publicKey,latest,instructions,priorityFeeLamports:1401n});
  const alternateDecoded=getTransactionDecoder().decode(alternate.serialize());
  const alternateWire=Buffer.from(getTransactionEncoder().encode({...alternateDecoded,signatures:{...alternateDecoded.signatures,[root.creator]:ed25519.sign(alternateDecoded.messageBytes,creator.secretKey.subarray(0,32))}})).toString('base64');
  return {root,d,saved,signature,wire,alternateWire,state,data,io};
}
const prepareInput=f=>({flow:'staged-v1',launchId:f.root.id,creator:f.root.creator,mint:f.root.mint,feeAllocationVersion:2});

test('single-step submit persists exact signed bytes and uses RPC preflight, never Jito',async()=>{
  const f=fixture();
  const result=await submitStaged(f.d,{wire:f.wire},f.io);
  assert.equal(result.status,'submitted');
  assert.deepEqual(f.state.sends,[f.wire]);
  assert.equal(f.data.get('staged/decisions/'+f.d.id+'.json').kind,'signed');
  assert.equal(f.state.simulations,1);
});
test('duplicate preparation returns one immutable attempt',async()=>{
  const f=fixture();
  const results=await Promise.all([prepareStaged(prepareInput(f),f.io),prepareStaged(prepareInput(f),f.io)]);
  assert.equal(results[0].id,results[1].id);
  assert.equal(results[0].wire,results[1].wire);
});
test('refresh retires an unsigned expired attempt before allowing a successor',async()=>{
  const f=fixture();f.state.now=f.d.expiresAt+1;
  const input={...prepareInput(f),previousId:f.d.id};
  const [a,b]=await Promise.all([prepareStaged(input,f.io),prepareStaged(input,f.io)]);
  assert.notEqual(a.id,f.d.id);assert.equal(a.id,b.id);
  assert.equal(f.data.get('staged/decisions/'+f.d.id+'.json').kind,'expired');
  f.state.now=f.d.expiresAt-1;
  assert.equal((await submitStaged(f.d,{wire:f.wire},f.io)).status,'expired');
  assert.equal(f.state.sends.length,0);
});
test('a signature that wins retirement fencing blocks replacement even if signed outbox write was interrupted',async()=>{
  const f=fixture();f.state.now=f.d.expiresAt+1;
  f.data.set('staged/decisions/'+f.d.id+'.json',{kind:'signed',saved:f.saved});
  await assert.rejects(prepareStaged({...prepareInput(f),previousId:f.d.id},f.io),/still signed|confirming/);
  assert.equal(f.data.get('signed/'+f.d.id+'.json').signature,f.signature);
  assert.equal(f.state.sends.length,0);
});
test('expired signed attempts are replaced only after finalized height followed by a fresh absent status',async()=>{
  const f=fixture();f.data.set('signed/'+f.d.id+'.json',f.saved);f.state.height=101;
  const next=await prepareStaged({...prepareInput(f),previousId:f.d.id},f.io);
  assert.notEqual(next.id,f.d.id);
  assert.deepEqual(f.state.events.slice(0,2),['height','status']);
  assert.equal(f.data.get('staged/outcomes/'+f.d.id+'.json').status,'expired');
});
test('unfinalized errors and lagging or missing status context never permit replacement or send',async()=>{
  const f=fixture();f.data.set('signed/'+f.d.id+'.json',f.saved);f.state.height=101;
  f.state.chain={confirmationStatus:'confirmed',err:{InstructionError:[0,'bad']}};
  assert.equal((await statusStaged(f.d,f.saved,true,f.io)).status,'confirming');
  f.state.chain=null;f.state.slot=99;
  assert.equal((await statusStaged(f.d,f.saved,true,f.io)).status,'checking');
  f.state.slot=undefined;
  assert.equal((await statusStaged(f.d,f.saved,true,f.io)).status,'checking');
  await assert.rejects(prepareStaged({...prepareInput(f),previousId:f.d.id},f.io),/still signed/);
  assert.equal(f.state.sends.length,0);
});
test('successful status with delayed receipt indexing retains the original signed attempt',async()=>{
  const f=fixture();f.data.set('signed/'+f.d.id+'.json',f.saved);f.state.chain={confirmationStatus:'finalized',err:null};
  await assert.rejects(statusStaged(f.d,f.saved,false,f.io),/indexing is delayed/);
  assert.equal(f.data.has('staged/outcomes/'+f.d.id+'.json'),false);
  assert.equal(f.data.get('signed/'+f.d.id+'.json').wire,f.wire);
});
test('setup finalization unlocks creation only after exact receipt validation',async()=>{
  const f=fixture();f.state.chain={confirmationStatus:'finalized',err:null};
  f.state.receipt={slot:100,transaction:{message:(await import('../lib/launch-wire.mjs')).decodeLaunchTransaction(Buffer.from(f.wire,'base64')).message},meta:{err:null,preBalances:[1000000],postBalances:[999999]}};
  const result=await statusStaged(f.d,f.saved,false,f.io);
  assert.equal(result.status,'phase-confirmed');assert.equal(result.phase,'setup');
  assert.equal((await prepareStaged(prepareInput(f),f.io)).phase,'create');
});
test('finalized buy failure preserves the created coin and retries buy with the same mint',async()=>{
  const f=fixture({phase:'buy',buy:true});f.data.set('signed/'+f.d.id+'.json',f.saved);
  f.state.chain={confirmationStatus:'finalized',err:{InstructionError:[0,'bad']}};
  const result=await statusStaged(f.d,f.saved,false,f.io);
  assert.equal(result.status,'failed');assert.equal(result.created,true);
  const next=await prepareStaged({...prepareInput(f),previousId:f.d.id},f.io);
  assert.equal(next.phase,'buy');assert.equal(next.mint,f.root.mint);
  assert.equal(next.coin.mint,f.root.mint);
});
test('a foreign root cannot acquire the same mint after the first signed launch',async()=>{
  const f=fixture();f.data.set('staged/mints/'+f.root.mint+'.json',{id:crypto.randomUUID()});
  await assert.rejects(submitStaged(f.d,{wire:f.wire},f.io),/another active launch/);
  assert.equal(f.state.sends.length,0);
});
test('another tab completing a phase prevents duplicate broadcast and returns canonical progress',async()=>{
  const f=fixture();f.data.set(`staged/completed/${f.root.id}/setup.json`,{id:crypto.randomUUID(),signature:'canonical'});
  const result=await statusStaged(f.d,f.saved,true,f.io);
  assert.equal(result.status,'phase-confirmed');assert.equal(result.signature,'canonical');
  assert.equal(f.state.sends.length,0);
});
test('a slow first approval records a never-broadcast expiry and permits only the current phase to retry',async()=>{
  const f=fixture({phase:'buy',buy:true});f.state.now=f.d.expiresAt+1;
  const result=await submitStaged(f.d,{wire:f.wire},f.io);
  assert.equal(result.status,'expired');assert.equal(result.created,true);
  assert.equal((await statusStaged(f.d,f.saved,true,f.io)).status,'expired');
  assert.equal(f.state.sends.length,0);assert.equal(f.state.simulations,0);
  const next=await prepareStaged({...prepareInput(f),previousId:f.d.id},f.io);
  assert.notEqual(next.id,f.d.id);assert.equal(next.phase,'buy');assert.equal(next.coin.mint,f.root.mint);
});
test('a late resubmission recovers an accepted signature after an interrupted outbox write',async()=>{
  const f=fixture();f.state.now=f.d.expiresAt+1;f.state.slot=99;
  f.data.set('staged/decisions/'+f.d.id+'.json',{kind:'signed',saved:f.saved});
  assert.equal((await submitStaged(f.d,{wire:f.wire},f.io)).status,'checking');
  assert.equal(f.data.get('signed/'+f.d.id+'.json').wire,f.wire);
  assert.equal(f.data.has('staged/outcomes/'+f.d.id+'.json'),false);
  assert.equal(f.state.sends.length,0);
});
test('competing valid wallet signatures recover the canonical bytes on both submit and status',async()=>{
  const f=fixture();f.state.slot=99;
  assert.equal((await submitStaged(f.d,{wire:f.wire},f.io)).status,'checking');
  const conflict=await submitStaged(f.d,{wire:f.alternateWire},f.io);
  assert.equal(conflict.status,'canonical-signed');assert.equal(conflict.signature,f.signature);assert.equal(conflict.wire,f.wire);
  assert.equal(conflict.id,f.d.id);assert.equal(conflict.launchId,f.root.id);assert.equal(conflict.phase,f.d.phase);
  const alternateSignature=cloutPaymentSignature(Buffer.from(f.alternateWire,'base64'));
  assert.notEqual(alternateSignature,f.signature);
  assert.deepEqual(await statusStaged(f.d,f.saved,false,f.io,alternateSignature),conflict);
  assert.equal(f.state.sends.length,0);
});
test('status restores the accepted signature from its decision if the outbox write was interrupted',async()=>{
  const f=fixture();f.state.slot=99;
  f.data.set('staged/decisions/'+f.d.id+'.json',{kind:'signed',saved:f.saved});
  assert.equal((await statusStaged(f.d,null,false,f.io,f.signature)).status,'checking');
  assert.equal(f.data.get('signed/'+f.d.id+'.json').signature,f.signature);
});
