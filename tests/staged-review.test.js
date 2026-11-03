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
