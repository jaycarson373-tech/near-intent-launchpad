import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,SystemProgram} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction,createCloseAccountInstruction,getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID,AccountLayout} from '@solana/spl-token';
import {compactTokenSetup,assertLaunchTraceBudget,blockedLaunchResult} from '../lib/launch-budget.mjs';
import {NEAR} from '../lib/solana-rpc.mjs';

const user=Keypair.generate().publicKey,mint=new PublicKey(NEAR),ata=getAssociatedTokenAddressSync(mint,user);
const setup=createAssociatedTokenAccountIdempotentInstruction(user,ata,user,mint);
function tokenInfo(owner=user,asset=mint){
  const data=Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({mint:asset,owner,amount:0n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  return {owner:TOKEN_PROGRAM_ID,data,lamports:2039280,executable:false};
}
test('ATA compaction preserves missing/dust-prefunded setup and exact non-setup instructions',async()=>{
  const transfer=SystemProgram.transfer({fromPubkey:user,toPubkey:Keypair.generate().publicKey,lamports:1});
  const instructions=[setup,transfer,setup];
  assert.deepEqual(await compactTokenSetup(instructions,{getMultipleAccountsInfo:async()=>[null,null]}),[setup,transfer]);
  assert.deepEqual(await compactTokenSetup(instructions,{getMultipleAccountsInfo:async()=>[{owner:SystemProgram.programId,data:Buffer.alloc(0)},null]}),[setup,transfer]);
  assert.deepEqual(await compactTokenSetup(instructions,{getMultipleAccountsInfo:async()=>[tokenInfo(),tokenInfo()]}),[transfer]);
});
test('an occupied ATA with another owner or mint cannot be skipped as ready',async()=>{
  for(const info of [tokenInfo(Keypair.generate().publicKey),tokenInfo(user,Keypair.generate().publicKey)])
    await assert.rejects(compactTokenSetup([setup],{getMultipleAccountsInfo:async()=>[info]}),/unexpected/);
});
test('setup after a closed account is retained rather than using stale initial state',async()=>{
  const close=createCloseAccountInstruction(ata,user,user);
  assert.deepEqual(await compactTokenSetup([setup,close,setup],{getMultipleAccountsInfo:async()=>[tokenInfo(),tokenInfo()]}),[close,setup]);
});
test('full trace capacity includes CPIs and measured wallet-added security checks',()=>{
  const tx={message:{compiledInstructions:Array(11).fill({})}};
  // HAR: review had 11 instructions; Phantom added 21. A 49-CPI
  // create/buy cannot safely fit despite an unsigned simulation succeeding.
  assert.throws(()=>assertLaunchTraceBudget(tx,{value:{err:null,innerInstructions:[{instructions:Array(49).fill({})}]}}),/wallet security/);
  assert.doesNotThrow(()=>assertLaunchTraceBudget(tx,{value:{err:null,innerInstructions:[{instructions:Array(32).fill({})}]}}));
  assert.throws(()=>assertLaunchTraceBudget(tx,{value:{err:null}}),/could not verify/);
  assert.throws(()=>assertLaunchTraceBudget(tx,{value:{err:{InstructionError:[12,'MaxInstructionTraceLengthExceeded']}}}),/combined swap/);
});
test('a pre-broadcast rejection is blocked, never submitted or confirmed',()=>{
  const r=blockedLaunchResult({mint:'mint'},'signature','instruction capacity exceeded');
  assert.equal(r.status,'blocked');assert.equal(r.signature,'signature');assert.equal(r.error,'instruction capacity exceeded');
});
