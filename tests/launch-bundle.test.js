import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Keypair,PublicKey,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {ed25519} from '@noble/curves/ed25519';
import {getTransactionDecoder,getTransactionEncoder} from '@solana/kit';
import {partitionLaunch,simulateLaunchBundle,verifySignedBundle,bundleProgress,jitoRequest} from '../lib/launch-bundle.mjs';
import {compileLaunchV1} from '../lib/launch-wire.mjs';
import {NEAR} from '../lib/solana-rpc.mjs';

const payer=Keypair.generate(),mint=Keypair.generate(),tip=Keypair.generate().publicKey;
const memo=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const ix=(program,data,keys=[])=>new TransactionInstruction({programId:program,keys,data:Buffer.from(data)});
const note=text=>ix(memo,text);
test('swap and initial buy stay in the same bundle transaction, with tip conditional on that transaction',()=>{
  const near=new PublicKey(NEAR),nearAta=createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,getAssociatedTokenAddressSync(near,payer.publicKey),payer.publicKey,near,TOKEN_PROGRAM_ID);
  const baseAta=createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,getAssociatedTokenAddressSync(mint.publicKey,payer.publicKey,false,TOKEN_2022_PROGRAM_ID),payer.publicKey,mint.publicKey,TOKEN_2022_PROGRAM_ID);
  const create=note('create and immutable fees'),buy=ix(new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),createHash('sha256').update('global:buy_exact_quote_in_v3').digest().subarray(0,8));
  const swap=note('bounded exact-input swap');
  const groups=partitionLaunch({launch:[nearAta,create,baseAta,buy],route:[nearAta,swap],payer:payer.publicKey,mint:mint.publicKey,tip});
  assert.equal(groups.length,3);assert.deepEqual(groups[1],[create]);
  assert.equal(groups[2][0],swap);assert.equal(groups[2][1],baseAta);assert.equal(groups[2][2],buy);
  assert.ok(groups[2].at(-1).programId.equals(SystemProgram.programId));
  assert.ok(groups[0].every(i=>i===nearAta));
  assert.throws(()=>partitionLaunch({launch:[create],route:[swap],payer:payer.publicKey,mint:mint.publicKey,tip}),/exactly/);
});

function reviewed(){
  const latest={blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:123};
  const instructions=[note('account setup'),ix(SystemProgram.programId,'test mint signer',[{pubkey:mint.publicKey,isSigner:true,isWritable:true}]),note('swap and buy')];
  return {wires:instructions.map(i=>Buffer.from(compileLaunchV1({payer:payer.publicKey,latest,instructions:[i]}).serialize()).toString('base64')),creationIndex:1};
}
function sign(wire,includeMint=true){
  const decoded=getTransactionDecoder().decode(Buffer.from(wire,'base64'));
  const signatures={...decoded.signatures,[payer.publicKey.toBase58()]:ed25519.sign(decoded.messageBytes,payer.secretKey.slice(0,32))};
  if(includeMint&&mint.publicKey.toBase58() in decoded.signatures)signatures[mint.publicKey.toBase58()]=ed25519.sign(decoded.messageBytes,mint.secretKey.slice(0,32));
  return Buffer.from(getTransactionEncoder().encode({...decoded,signatures})).toString('base64');
}
test('bundle authorization rejects missing, reordered, replayed or incompletely signed pieces',()=>{
  const review=reviewed(),signed=review.wires.map(w=>sign(w)),ok=verifySignedBundle(review,signed);
  assert.equal(ok.signatures.length,3);assert.equal(ok.signature,ok.signatures[1]);
  assert.throws(()=>verifySignedBundle(review,signed.slice(1)),/incomplete/);
  assert.throws(()=>verifySignedBundle(review,[signed[1],signed[0],signed[2]]),/changed/);
  assert.throws(()=>verifySignedBundle(review,[signed[0],sign(review.wires[1],false),signed[2]]),/incompletely/);
  assert.throws(()=>verifySignedBundle(review,[signed[0],signed[1],sign(reviewed().wires[2])]),/changed/);
});
test('partial confirmation and unknown outcomes never become successful or freely retryable launches',()=>{
  const done={confirmationStatus:'finalized',err:null},pending={confirmationStatus:'confirmed',err:null},failed={confirmationStatus:'finalized',err:{InstructionError:[0,'InvalidAccountData']}};
  assert.equal(bundleProgress([done,done,done]),'finalized');
  assert.equal(bundleProgress([done,pending,null]),'confirming');
  assert.equal(bundleProgress([done,null,null],{expired:true}),'reconciling');
  assert.equal(bundleProgress([done,failed,null]),'reconciling');
  assert.equal(bundleProgress([null,null,null]),'unseen');
  assert.equal(bundleProgress([null,null,null],{expired:true,mintExists:true}),'reconciling');
  assert.equal(bundleProgress([null,null,null],{expired:true}),'review');
  assert.equal(bundleProgress([failed,null,null],{expired:true}),'failed');
});
test('bundle simulation is sequential and exact; errors, skipped results and incomplete account data fail closed',async()=>{
  const good={context:{slot:1},value:{summary:'succeeded',transactionResults:Array.from({length:3},()=>({err:null,logs:['success'],fee:6400,preExecutionAccounts:[null],postExecutionAccounts:[null]}))}};
  let params;
  const rpc={_rpcRequest:async(method,p)=>{assert.equal(method,'simulateBundle');params=p;return {result:good}}};
  await simulateLaunchBundle(rpc,['one','two','three'],['address'],{signed:true});
  assert.equal(params[1].skipSigVerify,false);assert.equal(params[1].replaceRecentBlockhash,false);
  assert.deepEqual(params[0].encodedTransactions,['one','two','three']);
  for(const mutation of [r=>r.value.summary='failed',r=>r.value.transactionResults[1].err={InstructionError:[0,'bad']},r=>r.value.transactionResults.pop(),r=>r.value.transactionResults[0].preExecutionAccounts=[],r=>r.value.transactionResults[2].fee=500001]){
    const value=structuredClone(good);mutation(value);
    await assert.rejects(simulateLaunchBundle({_rpcRequest:async()=>({result:value})},['one','two','three'],['address']));
  }
});
test('relay errors cannot be mistaken for bundle acceptance',async()=>{
  await assert.rejects(jitoRequest('sendBundle',[],{transport:async()=>new Response(JSON.stringify({error:{code:-1,message:'rejected'}}))}),/could not accept/);
});
