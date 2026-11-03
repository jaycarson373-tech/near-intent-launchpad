import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {INTENT_MINT,feeBeneficiaries} from '../lib/fee-allocation.mjs';
import {RewardJournal} from '../worker/journal.mjs';
import {registerCoin,reserveJob,settleJob,obligations,publicProjection} from '../worker/engine.mjs';
import {POLICY_HASH} from '../lib/reward-readiness.mjs';
import {NEAR} from '../lib/solana-rpc.mjs';
import {createHmac} from 'node:crypto';
import {envelope,decodeEnvelope} from '../worker/journal.mjs';
import {prepare} from '../server/pump-launch.js';
import {launchMemo} from '../lib/launch-bundle.mjs';
const mint=Keypair.generate().publicKey.toBase58(),treasury=Keypair.generate().publicKey.toBase58();
const receipt=(m=mint,v=2)=>({mint:m,feeTreasury:treasury,rewardPolicyHash:POLICY_HASH,quoteMint:NEAR,signature:'test-only-receipt',feeAllocationVersion:v});
function claim(j,m=mint,signature='test-only-claim') {
 return reserveJob(j,m,'claim',{signature,wire:'test-only-not-broadcast',last_valid:1,plan:{}},1);
}
test('v2 beneficiary split is exact, conserves integer dust and never applies 80/20 twice to INTENT',()=>{
 for(const raw of [0n,1n,4n,5n,10001n,18446744073709551615n]) {
  const r=feeBeneficiaries(mint,raw,2);
  assert.equal(BigInt(r[1].raw),raw*2000n/10000n);
  assert.equal(r.reduce((n,x)=>n+BigInt(x.raw),0n),raw);
  assert.deepEqual(feeBeneficiaries(INTENT_MINT,raw,2),[{mint:INTENT_MINT,raw:String(raw)}]);
  assert.deepEqual(feeBeneficiaries(mint,raw,1),[{mint,raw:String(raw)}]);
 }
 assert.throws(()=>feeBeneficiaries(mint,-1n,2));assert.throws(()=>feeBeneficiaries(mint,1n,3));
});
test('confirmed community fees fund distinct holder ledgers atomically and retry once',()=>{
 const j=new RewardJournal(':memory:');try {
  registerCoin(j,receipt(),treasury);const job=claim(j);
  settleJob(j,job,{status:'confirmed',result:{raw:'10001'}},2);
  settleJob(j,job,{status:'confirmed',result:{raw:'10001'}},3);
  assert.equal(j.coin(mint).available,'5201');assert.equal(j.coin(mint).reserve,'2800');
  assert.equal(j.coin(INTENT_MINT).available,'1300');assert.equal(j.coin(INTENT_MINT).reserve,'700');
  assert.equal(obligations(j),10001n);assert.equal(j.db.prepare('SELECT COUNT(*) n FROM fee_routes').get().n,2);
  const publicData=publicProjection(j,mint,4);assert.equal(publicData.intentRoutedRaw,'2000');assert.equal(publicData.feeAllocationVersion,2);assert.equal(publicData.beneficiaryRoutes.length,2);
 }finally{j.close();}
});
test('INTENT own fees remain 100% payable to its holders with the timing reserve inside their allocation',()=>{
 const j=new RewardJournal(':memory:');try {
  registerCoin(j,receipt(INTENT_MINT),treasury);
  settleJob(j,claim(j,INTENT_MINT),{status:'confirmed',result:{raw:'10000'}},2);
  assert.equal(j.coin(INTENT_MINT).available,'6500');assert.equal(j.coin(INTENT_MINT).reserve,'3500');assert.equal(obligations(j),10000n);
  assert.equal(j.db.prepare('SELECT COUNT(*) n FROM fee_routes').get().n,1);
 }finally{j.close();}
});
test('historical fee terms cannot be reclassified and failed claims create no beneficiary funds',()=>{
 const j=new RewardJournal(':memory:');try {
  registerCoin(j,receipt(mint,1),treasury);
  assert.throws(()=>registerCoin(j,receipt(),treasury));assert.equal(j.coin(mint).allocation_version,1);
  settleJob(j,claim(j),{status:'failed'},2);assert.equal(obligations(j),0n);assert.equal(j.coin(INTENT_MINT),undefined);
  assert.throws(()=>registerCoin(j,receipt(INTENT_MINT,3),treasury));assert.equal(j.coin(INTENT_MINT),undefined);
 }finally{j.close();}
});
test('an interrupted beneficiary allocation rolls back all credits, routes and claim settlement',()=>{
 const j=new RewardJournal(':memory:');try {
  registerCoin(j,receipt(),treasury);const job=claim(j);
  j.db.prepare('INSERT INTO fee_routes VALUES(?,?,?,?,?,?)').run(job.signature,mint,INTENT_MINT,'0','0','0');
  assert.throws(()=>settleJob(j,job,{status:'confirmed',result:{raw:'10000'}},2));
  assert.equal(obligations(j),0n);assert.equal(j.coin(INTENT_MINT),undefined);assert.equal(j.pending().status,'pending');assert.equal(j.db.prepare('SELECT COUNT(*) n FROM claims').get().n,0);
 }finally{j.close();}
});
test('authenticated v1 journals remain readable and new checkpoints fence out old allocation workers',()=>{
 const context={treasury,policyHash:POLICY_HASH,secret:Buffer.alloc(32,4)},database=Buffer.from('SQLite format 3\0test-only journal content');
 const current=envelope(database,context,7),{authentication:_authentication,...body}=JSON.parse(current);
 assert.equal(body.version,2);assert.deepEqual(decodeEnvelope(current,context).database,database);
 body.version=1;
 const legacy=Buffer.from(JSON.stringify({...body,authentication:createHmac('sha256',context.secret).update(JSON.stringify(body)).digest('hex')}));
 assert.deepEqual(decodeEnvelope(legacy,context).database,database);
});
test('stale clients cannot prepare a launch under undisclosed new beneficiary terms',async()=>{
 for(const feeAllocationVersion of [undefined,1,3])await assert.rejects(prepare({flow:'v0-bundle',feeAllocationVersion}),error=>error.status===409&&/Reload/.test(error.message));
});
test('v2 beneficiary terms are committed in the signed launch memo while legacy memos remain identical',()=>{
 const record={mint,creator:treasury,creatorFeeBps:30,feeTreasury:treasury,rewardPolicyHash:POLICY_HASH,devBuyRaw:'0',devBuySolRaw:'0'};
 const legacy=launchMemo('test-only-id',record).data;
 assert.deepEqual(legacy,launchMemo('test-only-id',{...record,feeAllocationVersion:1}).data);
 assert.notDeepEqual(legacy,launchMemo('test-only-id',{...record,feeAllocationVersion:2}).data);
});
