import test from 'node:test';
import assert from 'node:assert/strict';
import { phaseReceipt, stagedContinuation, finishableBuy } from '../lib/staged-review.mjs';
const saved=()=>({creator:'owner',publicKey:'mint',launchId:'root',completedPhases:['setup'],details:{name:'Coin'},review:{id:'create-attempt',flow:'staged-v1',launchId:'root',phase:'create',creator:'owner',mint:'mint'},signed:new Uint8Array([1]),signature:'signature'});
test('confirmed creation retains its immutable root, mint and live coin but clears only the current signed attempt',()=>{
 const original=saved(),next=phaseReceipt(original,{status:'phase-confirmed',launchId:'root',phase:'create',signature:'signature',coin:{mint:'mint'}});
 assert.deepEqual(next.completedPhases,['setup','create']);assert.equal(next.launchId,'root');assert.equal(next.publicKey,'mint');assert.equal(next.review.id,'create-attempt');assert.deepEqual(next.coin,{mint:'mint'});assert.equal(next.signed,undefined);assert.equal(original.signature,'signature');
});
test('a receipt for another phase or root cannot release signed recovery',()=>{
 assert.throws(()=>phaseReceipt(saved(),{status:'phase-confirmed',launchId:'other',phase:'create',signature:'signature'}));
 assert.throws(()=>phaseReceipt(saved(),{status:'phase-confirmed',launchId:'root',phase:'buy',signature:'signature'}));
});
test('continuation binds a retry to root and predecessor and rejects account changes or unknown signed outcomes',()=>{
 const next=phaseReceipt(saved(),{status:'phase-confirmed',launchId:'root',phase:'create',signature:'signature'});
 assert.deepEqual(stagedContinuation(next,'owner'),{flow:'staged-v1',launchId:'root',previousId:'create-attempt',creator:'owner',mint:'mint',feeAllocationVersion:2});
 assert.throws(()=>stagedContinuation(next,'other'));assert.throws(()=>stagedContinuation(saved(),'owner'));
});
test('finishing without buy requires confirmed creation and no signed bytes',()=>{
 const next=phaseReceipt(saved(),{status:'phase-confirmed',launchId:'root',phase:'create',signature:'signature',coin:{mint:'mint'}});
 assert.equal(finishableBuy(next),true);assert.equal(finishableBuy({...next,signed:new Uint8Array([1])}),false);assert.equal(finishableBuy(saved()),false);
});
test('unsigned initial review refresh stays on its existing root and exact predecessor',()=>{
 const original=saved();delete original.launchId;delete original.signed;delete original.signature;
 assert.equal(stagedContinuation(original,'owner').launchId,'root');
});
test('canonical phase completion from a later attempt releases the original expired attempt on the same root',()=>{
 const next=phaseReceipt(saved(),{status:'phase-confirmed',launchId:'root',phase:'create',signature:'replacement-signature',coin:{mint:'mint'}});
 assert.equal(next.signature,undefined);assert.deepEqual(next.completedPhases,['setup','create']);
});
test('canonical completion rejects missing signature and foreign coin receipts',()=>{
 assert.throws(()=>phaseReceipt(saved(),{status:'phase-confirmed',launchId:'root',phase:'create',signature:''}));
 assert.throws(()=>phaseReceipt(saved(),{status:'phase-confirmed',launchId:'root',phase:'create',signature:'signature',coin:{mint:'other'}}));
});

import {Keypair, SystemProgram, TransactionInstruction, PublicKey} from '@solana/web3.js';
import {getTransactionDecoder,getTransactionEncoder} from '@solana/kit';
import {ed25519} from '@noble/curves/ed25519';
import {compileLaunchV1} from '../lib/launch-wire.mjs';
import {cloutPaymentSignature} from '../lib/launch-signatures.mjs';
import {canonicalSignedReceipt} from '../lib/staged-review.mjs';
function canonicalFixture() {
 const payer=Keypair.fromSeed(new Uint8Array(32).fill(1)),mint=Keypair.fromSeed(new Uint8Array(32).fill(2));
 const latest={blockhash:Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58(),lastValidBlockHeight:100};
 const transfer=SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:mint.publicKey,lamports:1});
 const build=instructions=>compileLaunchV1({payer:payer.publicKey,latest,instructions}).serialize();
 const reviewed=build([transfer]);
 const canonical=build([transfer,new TransactionInstruction({programId:new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),keys:[],data:Buffer.from([1])})]);
 const sign=wire=>{const decoded=getTransactionDecoder().decode(wire);return new Uint8Array(getTransactionEncoder().encode({...decoded,signatures:{...decoded.signatures,[payer.publicKey.toBase58()]:ed25519.sign(decoded.messageBytes,payer.secretKey.slice(0,32))}}));};
 const original=sign(reviewed),wire=sign(canonical),creator=payer.publicKey.toBase58(),publicKey=mint.publicKey.toBase58();
 const state={creator,publicKey,launchId:'root',details:{name:'Retained coin'},completedPhases:[],signed:original,signature:cloutPaymentSignature(original),review:{id:'attempt',flow:'staged-v1',launchId:'root',phase:'setup',creator,mint:publicKey,wire:Buffer.from(reviewed).toString('base64')}};
 const receipt={status:'canonical-signed',id:'attempt',launchId:'root',phase:'setup',signature:cloutPaymentSignature(wire),wire:Buffer.from(wire).toString('base64')};
 return {state,receipt,wire,sign,build,transfer};
}
test('canonical signed adoption retains the root and metadata while replacing only exact verified signed recovery',()=>{
 const {state,receipt,wire}=canonicalFixture(),next=canonicalSignedReceipt(state,receipt);
 assert.deepEqual(next.signed,wire);assert.equal(next.signature,receipt.signature);assert.notEqual(next.signature,state.signature);
 assert.equal(next.launchId,'root');assert.equal(next.publicKey,state.publicKey);assert.equal(next.details,state.details);assert.equal(next.review,state.review);assert.deepEqual(state.signed,canonicalFixture().state.signed);
});
test('canonical signed adoption rejects foreign identity, forged signatures, malformed bytes and changed effects without replacing recovery',()=>{
 const {state,receipt,sign,build,transfer}=canonicalFixture(),original=state.signature;
 for(const patch of [{id:'foreign'},{launchId:'foreign'},{phase:'buy'},{status:'submitted'},{signature:'forged'},{wire:'invalid!'}]) assert.throws(()=>canonicalSignedReceipt(state,{...receipt,...patch}));
 const changed=sign(build([{...transfer,data:Buffer.from(transfer.data.map(byte=>byte^1))}]));
 assert.throws(()=>canonicalSignedReceipt(state,{...receipt,wire:Buffer.from(changed).toString('base64'),signature:cloutPaymentSignature(changed)}));
 for(const patch of [{creator:'foreign'},{publicKey:'foreign'},{launchId:'foreign'},{review:{...state.review,wire:undefined}}]) assert.throws(()=>canonicalSignedReceipt({...state,...patch},receipt));
 const invalid=Buffer.from(receipt.wire,'base64');invalid[10]^=1;
 assert.throws(()=>canonicalSignedReceipt(state,{...receipt,wire:invalid.toString('base64')}));assert.equal(state.signature,original);
});
