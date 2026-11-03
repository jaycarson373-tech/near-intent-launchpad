import BN from 'bn.js';
import {PublicKey} from '@solana/web3.js';
import {getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, unpackAccount, unpackMint} from '@solana/spl-token';
import {pump, verifyFeeAssignment} from './pump-adapter.mjs';
import {launchParts, buyInstructions, minimumTokensOut, launchMemo, WALLET_BYTE_ALLOWANCE} from './launch-bundle.mjs';
import {compactTokenSetup, assertLaunchTraceBudget} from './launch-budget.mjs';
import {compileLaunchV1} from './launch-wire.mjs';
import {solConversion, walletTokenState, verifyConversionEffects} from './sol-dev-buy.mjs';
import {NEAR, SOL} from './solana-rpc.mjs';
import {fail} from './http.js';

export const STAGED_FLOW = 'staged-v1';
export const PHASES = ['setup','create','buy'];
const MAX_V1_BYTES = 4096;
const SOL_HEADROOM = 500000n;
const MAX_CREATION_DEBIT = 50000000n;
export function nextLaunchPhase(root, completed) {
  if (!completed.setup) return 'setup';
  if (!completed.create) return 'create';
  return BigInt(root.devBuySolRaw)>0n && !completed.buy ? 'buy' : null;
}
export function compileStagedTransaction(root, instructions, latest) {
  const tx=compileLaunchV1({payer:new PublicKey(root.creator),latest,instructions});
  if(tx.serialize().length+WALLET_BYTE_ALLOWANCE>MAX_V1_BYTES)
    fail('This operation leaves too little room for wallet security checks. Keep this launch and retry.',503);
  return tx;
}
export async function buildStagedInstructions(root, phase, c, deps={}) {
  if(phase==='buy') return buildStagedBuy(root,c,deps);
  if(!['setup','create'].includes(phase)) fail('Unknown launch step. Reload the saved launch.');
  const parts=await launchParts({...root,creator:new PublicKey(root.creator),mint:new PublicKey(root.mint),uri:root.metadataUri,devBuyRaw:0n},c);
  const instructions=phase==='setup' ? await compactTokenSetup(parts.setup,c.rpc) : [...parts.create,...parts.fees];
  return {instructions,devBuyRaw:'0',minimumTokensRaw:'0',tracked:[]};
}
async function buildStagedBuy(root,c,deps) {
  const {creator,mint,state,mintState}=await liveBuyState(root,c,deps);
  const curve=state.bondingCurve;
  const route=root.fundingId?null:await (deps.conversion||solConversion)(root.creator,BigInt(root.devBuySolRaw),{mint:root.mint,treasury:root.feeTreasury});
  const devBuyRaw=route?.minimumRaw||root.devBuyRaw;
  const amount=pump.getBuyV3TokenAmountFromQuoteAmount({global:c.global,feeConfig:c.feeConfig,mintSupply:new BN(mintState.supply.toString()),bondingCurve:curve,curveBaseTokenBalance:state.curveBaseTokenBalance,amount:new BN(devBuyRaw)});
  if(amount.lten(0)||amount.gte(curve.realTokenReserves)) fail('This initial buy is too small or would graduate the market. Your coin remains live.');
  const buy=await buyInstructions({creator,mint,devBuyRaw:BigInt(devBuyRaw),amount,curve,c});
  const instructions=await compactTokenSetup([...(route?.instructions||[]),...buy],c.rpc);
  const tracked=await walletTokenState(c.rpc,root.creator,new Set(instructions.flatMap(ix=>ix.keys.map(k=>k.pubkey.toBase58()))));
  if(tracked.some(r=>r.state.mint.toBase58()===SOL&&r.state.amount>0n)) fail('Unwrap existing wrapped SOL before retrying this initial buy. Your coin remains live.');
  return {instructions,devBuyRaw:String(devBuyRaw),minimumTokensRaw:String(minimumTokensOut(amount)),tracked,atomicSolBuy:!!route};
}
async function liveBuyState(root,c,deps) {
  const creator=new PublicKey(root.creator),mint=new PublicKey(root.mint);
  await (deps.verifyFees||verifyFeeAssignment)(c.rpc,root.mint,root.feeTreasury,NEAR,root.creatorFeeBps);
  const online=new pump.OnlinePumpSdk(c.rpc);
  const [state,mintInfo]=await Promise.all([
    deps.buyState ? deps.buyState() : online.fetchBuyState(mint,creator,TOKEN_2022_PROGRAM_ID,new PublicKey(NEAR)),
    c.rpc.getAccountInfo(mint,'finalized'),
  ]);
  const curve=state.bondingCurve;
  if(!state.bondingCurveAccountInfo?.owner.equals(pump.PUMP_PROGRAM_ID)||curve.complete||curve.quoteMint.toBase58()!==NEAR||!curve.creator.equals(pump.feeSharingConfigPda(mint)))
    fail('The live market is no longer available for this initial buy. Your created coin remains live.');
  if(!mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) fail('The created mint could not be verified. Keep this launch receipt.');
  return {creator,mint,state,mintState:unpackMint(mint,mintInfo,TOKEN_2022_PROGRAM_ID)};
}
export function stagedAddresses(root,tracked=[]) {
  const creator=new PublicKey(root.creator),mint=new PublicKey(root.mint);
  return [...new Set([root.creator,pump.feeSharingConfigPda(mint).toBase58(),pump.bondingCurvePda(mint).toBase58(),getAssociatedTokenAddressSync(new PublicKey(NEAR),creator).toBase58(),getAssociatedTokenAddressSync(mint,creator,false,TOKEN_2022_PROGRAM_ID).toBase58(),...tracked.map(r=>r.address)])];
}
const decodeAccount=a=>({...a,owner:new PublicKey(a.owner),data:Buffer.from(a.data[0],'base64')});
export function verifyStagedSimulation(d,simulation,beforeBalance,tracked=[]) {
  const accounts=simulation.value.accounts;
  if(simulation.value.err!==null||!Array.isArray(accounts)||accounts.length!==d.simulationAddresses.length)
    fail('This launch step failed simulation. Keep the launch and refresh this step before approving.',503);
  if(d.phase==='create') verifyCreatedAccounts(d,accounts);
  if(d.phase==='buy') verifyStagedBuyEffects(d,accounts,tracked);
  return verifyStepDebit(d,beforeBalance,accounts[0]?.lamports);
}
function verifyStepDebit(d,beforeBalance,after) {
  if(!Number.isSafeInteger(after)||after<0||after>=beforeBalance)
    fail('The launch step debit could not be verified. Refresh this review.',503);
  const debit=BigInt(beforeBalance-after),input=d.atomicSolBuy?BigInt(d.devBuySolRaw):0n;
  if(debit>input+MAX_CREATION_DEBIT) fail('The launch step exceeds its bounded SOL budget. Refresh the review.');
  return debit;
}
function verifyCreatedAccounts(d,accounts) {
  if(!accounts[1]||!accounts[2]) fail('The creation simulation did not return its fee records. Retry this step.');
  const sharesInfo=decodeAccount(accounts[1]),curveInfo=decodeAccount(accounts[2]);
  if(!sharesInfo.owner.equals(pump.PUMP_FEE_PROGRAM_ID)||!curveInfo.owner.equals(pump.PUMP_PROGRAM_ID)) fail('Creation returned unexpected fee programs. Keep the launch receipt.');
  const shares=pump.PUMP_SDK.decodeSharingConfig(sharesInfo),curve=pump.PUMP_SDK.decodeBondingCurve(curveInfo);
  verifyShares(d,shares);
  if(curve.quoteMint.toBase58()!==NEAR||curve.creatorFeeBps.toNumber()!==d.creatorFeeBps||curve.creator.toBase58()!==pump.feeSharingConfigPda(new PublicKey(d.mint)).toBase58())
    fail('The created market differs from the reviewed NEAR market. Retry this step.');
}
function verifyShares(d,shares) {
  if(shares.mint.toBase58()!==d.mint||shares.shareholders.length!==1||shares.shareholders[0].address.toBase58()!==d.feeTreasury||shares.shareholders[0].shareBps!==10000||pump.isSharingConfigEditable({sharingConfig:shares}))
    fail('The creation simulation did not lock the reviewed holder fees. Retry this step.');
}
function verifyStagedBuyEffects(d,accounts,tracked) {
  const boughtAddress=d.simulationAddresses[4],raw=accounts[4];
  if(!raw) fail('The simulated initial buy did not return purchased tokens. Refresh this step.');
  const bought=unpackAccount(new PublicKey(boughtAddress),decodeAccount(raw),TOKEN_2022_PROGRAM_ID);
  const prior=tracked.find(r=>r.address===boughtAddress)?.state.amount||0n;
  if(bought.owner.toBase58()!==d.creator||bought.mint.toBase58()!==d.mint||bought.amount-prior<BigInt(d.minimumTokensRaw))
    fail('The simulated initial buy did not deliver its minimum to your wallet. Refresh this step.');
  // A recovered legacy conversion may spend only its already-finalized NEAR amount.
  const before=d.atomicSolBuy?tracked:tracked.map(row=>row.address===d.simulationAddresses[3]?{...row,state:{...row.state,amount:row.state.amount-BigInt(d.devBuyRaw)}}:row);
  if(before.some(row=>row.state.amount<0n)) fail('The saved converted NEAR is no longer available. Keep the original receipt.');
  verifyConversionEffects(before,new Map(d.simulationAddresses.map((a,i)=>[a,accounts[i]])),{creator:d.creator,mint:d.mint,minimumRaw:'0',atomicBuy:true});
}
export async function prepareStagedTransaction(root,phase,c,deps={}) {
  const built=await buildStagedInstructions(root,phase,c,deps),latest=await c.rpc.getLatestBlockhashAndContext('confirmed');
  const instructions=[...built.instructions,launchMemo(root.id,{...root,devBuyRaw:built.devBuyRaw})];
  const tx=compileStagedTransaction(root,instructions,latest.value);
  const d={...root,phase,devBuyRaw:built.devBuyRaw,minimumTokensRaw:built.minimumTokensRaw,atomicSolBuy:built.atomicSolBuy||false,simulationAddresses:stagedAddresses(root,built.tracked)};
  const before=await c.rpc.getBalanceAndContext(new PublicKey(root.creator),{commitment:'confirmed',minContextSlot:latest.context.slot});
  const simulation=await c.rpc.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',minContextSlot:before.context.slot,innerInstructions:true,accounts:{encoding:'base64',addresses:d.simulationAddresses}});
  assertLaunchTraceBudget(tx,simulation);
  const debit=verifyStagedSimulation(d,simulation,before.value,built.tracked);
  if(simulation.context.slot<before.context.slot) fail('The simulation is behind the reviewed balance. Refresh this step.',503);
  return {...d,wire:Buffer.from(tx.serialize()).toString('base64'),transactionVersion:1,lastValidBlockHeight:latest.value.lastValidBlockHeight,estimatedSolRaw:String(debit+SOL_HEADROOM),expiresAt:Date.now()+60000};
}
