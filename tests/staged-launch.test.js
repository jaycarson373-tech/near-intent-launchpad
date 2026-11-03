import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair, PublicKey, SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,MintLayout,AccountLayout,unpackAccount} from '@solana/spl-token';
import BN from 'bn.js';
import {buildStagedInstructions, compileStagedTransaction, nextLaunchPhase,verifyStagedSimulation,stagedAddresses} from '../lib/staged-launch.mjs';
import {pump} from '../lib/pump-adapter.mjs';
import {NEAR} from '../lib/solana-rpc.mjs';

const key = () => Keypair.generate().publicKey.toBase58();
const root = {id:crypto.randomUUID(),creator:key(),mint:key(),feeTreasury:key(),name:'Preview Test',symbol:'TEST',metadataUri:'https://example.invalid/metadata',creatorFeeBps:30,devBuySolRaw:'0',devBuyRaw:'0',rewardPolicyHash:'a'.repeat(64),feeAllocationVersion:2};
const c = {quote:{mint:NEAR,tokenProgram:TOKEN_PROGRAM_ID.toBase58(),creatorFeeBps:30},rpc:{getMultipleAccountsInfo:async keys=>keys.map(()=>null)}};
test('new launch phases never request buy before verified creation', () => {
  assert.equal(nextLaunchPhase(root,{}),'setup');
  assert.equal(nextLaunchPhase(root,{setup:{}}),'create');
  assert.equal(nextLaunchPhase(root,{setup:{},create:{}}),null);
  assert.equal(nextLaunchPhase({...root,devBuySolRaw:'10000000'},{setup:{},create:{}}),'buy');
  assert.equal(nextLaunchPhase({...root,devBuySolRaw:'10000000'},{setup:{},create:{},buy:{}}),null);
});
test('setup has no swap or creation; creation keeps the immutable fee lock together',async()=>{
  const setup=await buildStagedInstructions(root,'setup',c);
  assert.ok(setup.instructions.length>0);
  assert.ok(setup.instructions.every(ix=>ix.programId.toBase58()==='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'));
  const creation=await buildStagedInstructions(root,'create',c);
  assert.deepEqual(creation.instructions.map(ix=>ix.programId.toBase58()),[pump.PUMP_PROGRAM_ID.toBase58(),pump.PUMP_FEE_PROGRAM_ID.toBase58(),pump.PUMP_FEE_PROGRAM_ID.toBase58()]);
  const tx=compileStagedTransaction(root,creation.instructions,{blockhash:key(),lastValidBlockHeight:100});
  assert.equal(tx.message.version,1);
  assert.equal(tx.message.header.numRequiredSignatures,2);
  assert.ok(tx.serialize().length+200<=4096);
});
test('staged envelope rejects an oversized operation instead of splitting its swap',()=>{
  const ix=SystemProgram.transfer({fromPubkey:new PublicKey(root.creator),toPubkey:new PublicKey(key()),lamports:1});
  ix.data=Buffer.alloc(4096);
  assert.throws(()=>compileStagedTransaction(root,[ix],{blockhash:key(),lastValidBlockHeight:100}),/size|limit|room/i);
});
function buyFixture() {
  const mint=new PublicKey(root.mint),data=Buffer.alloc(MintLayout.span);
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  const curve={virtualTokenReserves:new BN('873000000000000'),virtualQuoteReserves:new BN('3687285223368'),realTokenReserves:new BN('593100000000000'),realQuoteReserves:new BN('687285223368'),tokenTotalSupply:new BN('1000000000000000'),creatorFeeBps:new BN(30),complete:false,quoteMint:new PublicKey(NEAR),creator:pump.feeSharingConfigPda(mint),isMayhemMode:false,isCashbackCoin:false};
  const state={bondingCurve:curve,bondingCurveAccountInfo:{owner:pump.PUMP_PROGRAM_ID},curveBaseTokenBalance:new BN('593100000000000')};
  const context={...c,global:{feeBasisPoints:new BN(100),creatorFeeBasisPoints:new BN(30),buybackBasisPoints:new BN(0),buybackFeeRecipients:[Keypair.generate().publicKey]},feeConfig:null,rpc:{...c.rpc,getAccountInfo:async()=>({owner:TOKEN_2022_PROGRAM_ID,data})}};
  const swap=SystemProgram.transfer({fromPubkey:new PublicKey(root.creator),toPubkey:Keypair.generate().publicKey,lamports:1});
  const deps={verifyFees:async()=>{},buyState:async()=>state,conversion:async()=>({minimumRaw:'1000000000',instructions:[swap]})};
  return {context,curve,state,deps,swap};
}
test('buy uses current reserves and keeps conversion instructions before the exact-quote purchase',async()=>{
  const f=buyFixture(),r={...root,devBuySolRaw:'10000000'};
  const built=await buildStagedInstructions(r,'buy',f.context,f.deps);
  assert.equal(built.instructions[0],f.swap);
  const trade=built.instructions.find(ix=>ix.programId.equals(pump.PUMP_PROGRAM_ID));
  const expected=pump.getBuyV3TokenAmountFromQuoteAmount({global:f.context.global,feeConfig:null,mintSupply:new BN('1000000000000000'),bondingCurve:f.curve,curveBaseTokenBalance:f.state.curveBaseTokenBalance,amount:new BN('1000000000')});
  assert.equal(trade.data.readBigUInt64LE(8),1000000000n);
  assert.equal(trade.data.readBigUInt64LE(16),BigInt(built.minimumTokensRaw));
  assert.equal(built.minimumTokensRaw,String(BigInt(expected.toString())-BigInt(expected.toString())/100n));
  f.curve.virtualQuoteReserves=f.curve.virtualQuoteReserves.muln(2);
  const changed=await buildStagedInstructions(r,'buy',f.context,f.deps);
  assert.ok(BigInt(changed.minimumTokensRaw)<BigInt(built.minimumTokensRaw));
  assert.equal(built.atomicSolBuy,true);
});
test('completed or foreign markets block the optional buy without conversion',async()=>{
  const f=buyFixture();let converted=false;f.deps.conversion=async()=>{converted=true;throw Error('unexpected');};
  f.curve.complete=true;
  await assert.rejects(buildStagedInstructions({...root,devBuySolRaw:'1'},'buy',f.context,f.deps),/no longer available/);
  assert.equal(converted,false);
});
function rawToken(mint,amount,program=TOKEN_PROGRAM_ID) {
  const data=Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({mint:new PublicKey(mint),owner:new PublicKey(root.creator),amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  return {owner:program.toBase58(),data:[data.toString('base64'),'base64'],lamports:2039280,executable:false};
}
test('atomic buy simulation requires a new token delta and preserves prior NEAR',()=>{
  const addresses=stagedAddresses(root);
  const nearBefore=rawToken(NEAR,100n),tokenBefore=rawToken(root.mint,20n,TOKEN_2022_PROGRAM_ID);
  const tracked=[[3,nearBefore,TOKEN_PROGRAM_ID],[4,tokenBefore,TOKEN_2022_PROGRAM_ID]].map(([i,raw,program])=>({address:addresses[i],program,state:unpackAccount(new PublicKey(addresses[i]),{...raw,owner:program,data:Buffer.from(raw.data[0],'base64')},program)}));
  const d={...root,phase:'buy',atomicSolBuy:true,devBuySolRaw:'10000000',devBuyRaw:'1000',minimumTokensRaw:'10',simulationAddresses:addresses};
  const accounts=[{lamports:990000},null,null,rawToken(NEAR,101n),rawToken(root.mint,30n,TOKEN_2022_PROGRAM_ID)];
  const simulation={value:{err:null,accounts}};
  assert.equal(verifyStagedSimulation(d,simulation,1000000,tracked),10000n);
  accounts[4]=rawToken(root.mint,29n,TOKEN_2022_PROGRAM_ID);
  assert.throws(()=>verifyStagedSimulation(d,simulation,1000000,tracked),/minimum/);
  accounts[4]=rawToken(root.mint,30n,TOKEN_2022_PROGRAM_ID);accounts[3]=rawToken(NEAR,99n);
  assert.throws(()=>verifyStagedSimulation(d,simulation,1000000,tracked),/existing|preserve/);
});
