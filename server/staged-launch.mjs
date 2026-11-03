import {randomUUID,createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,unpackMint} from '@solana/spl-token';
import * as store from '../lib/store.js';
import {fail,origin} from '../lib/http.js';
import {validate,publicCoin} from '../lib/launch-model.js';
import {connection,NEAR} from '../lib/solana-rpc.mjs';
import {checkNetwork,verifyFeeAssignment} from '../lib/pump-adapter.mjs';
import {rewardReadiness,POLICY_HASH} from '../lib/reward-readiness.mjs';
import {FEE_ALLOCATION_VERSION} from '../lib/fee-allocation.mjs';
import {STAGED_FLOW,PHASES,nextLaunchPhase,prepareStagedTransaction,verifyStagedSimulation} from '../lib/staged-launch.mjs';
import {decodeLaunchTransaction,readLaunchReceipt,MAX_LAUNCH_BASE64} from '../lib/launch-wire.mjs';
import {walletSignedLaunchMatches,cloutPaymentSignature} from '../lib/launch-signatures.mjs';
import {walletTokenState} from '../lib/sol-dev-buy.mjs';

const MAX_NETWORK_FEE=500000;
const idOk=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const outcomeKey=id=>'staged/outcomes/'+id+'.json';
const decisionKey=id=>'staged/decisions/'+id+'.json';
const completedKey=(root,phase)=>'staged/completed/'+root.id+'/'+phase+'.json';
const sameId=(a,b)=>a.id===b.id;
function ioFor(deps) {
  return {read:store.read,create:store.create,createOnce:store.createOnce,configured:store.configured,rpc:connection(),rewards:rewardReadiness,verifyFees:verifyFeeAssignment,checkNetwork,readReceipt:readLaunchReceipt,prepareTransaction:prepareStagedTransaction,verifySimulation:verifyStagedSimulation,fetch,origin,now:Date.now,...deps};
}
async function rootFor(id,io) {
  if(!idOk(id)) fail('Invalid saved launch. Reload the original launch.');
  const root=await io.read('drafts/'+id+'.json');
  if(root?.flow!==STAGED_FLOW||root.root!==true) fail('The saved staged launch was not found. Keep the original receipt.',404);
  return root;
}
async function completedPhases(root,io) {
  const rows=await Promise.all(PHASES.map(phase=>io.read(completedKey(root,phase))));
  return Object.fromEntries(PHASES.map((phase,i)=>[phase,rows[i]]).filter(([,row])=>row));
}
async function requireRewards(root,io) {
  const rewards=await io.rewards();
  if(!rewards.ready) fail('Holder rewards are not ready. Keep this launch and retry before approving.',503);
  if(root&&rewards.treasury!==root.feeTreasury) fail('The reward treasury changed. Keep the existing launch for reconciliation.',409);
  return rewards;
}
async function newRoot(raw,io) {
  const input=validate(raw),rewards=await requireRewards(null,io);
  await io.context(input.creatorFeeBps,io.rpc);
  if(await io.rpc.getAccountInfo(input.mint,'finalized')) fail('This mint already exists. Resume its saved launch.');
  const id=randomUUID(),uri=io.origin()+'/api/metadata?id='+id;
  const root={...input,id,root:true,flow:STAGED_FLOW,creator:input.creator.toBase58(),mint:input.mint.toBase58(),devBuySolRaw:String(input.devBuySolRaw),devBuyRaw:'0',feeTreasury:rewards.treasury,rewardPolicyHash:POLICY_HASH,feeAllocationVersion:FEE_ALLOCATION_VERSION,quoteMint:NEAR,metadataUri:uri,imageUrl:uri+'&image=1',createdAt:new Date(io.now()).toISOString()};
  if(raw.fundingId) await bindLegacyFunding(root,raw.fundingId,io);
  await io.create('drafts/'+id+'.json',root);
  await verifyMetadata(root,io);
  return root;
}
async function bindLegacyFunding(root,id,io) {
  if(!idOk(id)) fail('Invalid saved conversion. Keep its original receipt.');
  const funding=await io.read('funding/'+id+'.json');
  if(!funding) fail('The finalized conversion receipt was not found. Keep its original receipt.');
  const fields=['creator','mint','devBuySolRaw','feeTreasury'];
  if(fields.some(field=>funding[field]!==root[field])) fail('The saved SOL conversion belongs to another wallet, mint, amount or treasury.');
  root.fundingId=id;root.fundingSignature=funding.signature;root.devBuyRaw=funding.devBuyRaw;
}
async function verifyMetadata(root,io) {
  const options={signal:AbortSignal.timeout(12000),cache:'no-store'};
  const response=await io.fetch(root.metadataUri,options);
  if(!response.ok||!response.headers.get('content-type')?.includes('application/json')) fail('Coin metadata is not publicly reachable. Retry before approving.');
  const data=await response.json();
  if(data.name!==root.name||data.symbol!==root.symbol||data.image!==root.imageUrl) fail('Public metadata differs from the reviewed coin. Retry before approving.');
  const image=await io.fetch(root.imageUrl,options);
  if(!image.ok||image.headers.get('content-type')!==root.mime) fail('The public image could not be verified. Retry before approving.');
  if(hash(Buffer.from(await image.arrayBuffer()))!==hash(Buffer.from(root.image.split(',')[1],'base64'))) fail('The public image differs from the reviewed coin. Retry before approving.');
}
function publicReview(d,completed) {
  const fields=['id','flow','launchId','phase','wire','transactionVersion','expiresAt','estimatedSolRaw','devBuyRaw','devBuySolRaw','creatorFeeBps','name','symbol','mint','creator','feeTreasury','rewardPolicyHash','feeAllocationVersion','fundingId','atomicSolBuy'];
  return {...Object.fromEntries(fields.map(field=>[field,d[field]])),completedPhases:Object.keys(completed),...(completed.create?{coin:completed.create.coin}:{})};
}
export async function prepareStaged(raw,deps) {
  const io=ioFor(deps);
  if(raw.feeAllocationVersion!==FEE_ALLOCATION_VERSION) fail('Reload the page to use the current holder allocation.',409);
  if(!io.configured()) fail('Launch storage is unavailable. Retry before approving.',503);
  const root=raw.launchId?await rootFor(raw.launchId,io):await newRoot(raw,io);
  if(root.creator!==raw.creator||root.mint!==raw.mint) fail('Reconnect the original launch wallet and mint.');
  const completed=await completedPhases(root,io),phase=nextLaunchPhase(root,completed);
  if(!phase) return {status:'confirmed',coin:completed.create.coin};
  if(phase!=='buy') await requireRewards(root,io);
  const previous=await previousAttempt(raw.previousId,root,phase,io);
  const attempt=await phaseAttempt(root,phase,previous,io);
  await io.createOnce('drafts/'+attempt.id+'.json',attempt,sameId);
  return publicReview(attempt,completed);
}
async function phaseAttempt(root,phase,previous,io) {
  const slot='staged/attempts/'+root.id+'/'+phase+'/'+(previous?.id||'first')+'.json';
  let attempt=await io.read(slot);
  if(!attempt) {
    const c=await io.context(root.creatorFeeBps,io.rpc);
    if(phase==='create'&&await io.rpc.getAccountInfo(new PublicKey(root.mint),'finalized')) fail('This mint already exists. Resume the original creation receipt.');
    const built=await io.prepareTransaction(root,phase,c);
    const candidate={...built,id:randomUUID(),root:false,launchId:root.id,previousId:previous?.id||null,slot,flow:STAGED_FLOW};
    attempt=await io.createOnce(slot,candidate,(a,b)=>a.launchId===b.launchId&&a.phase===b.phase&&a.previousId===b.previousId);
  }
  return attempt;
}
async function previousAttempt(id,root,phase,io) {
  if(!id) return null;
  if(!idOk(id)) fail('Invalid previous launch attempt. Resume the saved review.');
  const previous=await io.read('drafts/'+id+'.json');
  if(previous?.launchId!==root.id) fail('The previous attempt belongs to another launch.');
  if(previous.phase!==phase) return null;
  const slot=await io.read(previous.slot);
  if(slot?.id!==id) fail('The previous launch attempt is not canonical. Keep its receipt.');
  const signed=await io.read('signed/'+id+'.json');
  if(!signed) {
    if(io.now()<=previous.expiresAt) return previousAttempt(previous.previousId,root,phase,io);
    return retireUnsigned(previous,io);
  }
  return replaceTerminal(previous,signed,io);
}
async function replaceTerminal(previous,signed,io) {
  const result=await statusStaged(previous,signed,false,io);
  if(!['failed','expired'].includes(result.status)) fail('The original step is still signed or confirming. Resume its receipt before retrying.',409);
  return previous;
}
async function retireUnsigned(previous,io) {
  // The same create-only decision slot arbitrates retirement and a racing signature.
  try {
    await io.createOnce(decisionKey(previous.id),{kind:'expired'},(a,b)=>a.kind===b.kind);
    return previous;
  } catch {
    const decision=await io.read(decisionKey(previous.id));
    if(decision?.kind!=='signed') fail('The previous attempt could not be reconciled. Keep its receipt.',503);
    const signed=decision.saved;
    await io.createOnce('signed/'+previous.id+'.json',signed,(a,b)=>a.signature===b.signature);
    return replaceTerminal(previous,signed,io);
  }
}
async function assertPhaseOpen(d,root,io) {
  const completed=await completedPhases(root,io);
  if(nextLaunchPhase(root,completed)!==d.phase) fail('This launch step is no longer active. Resume the saved launch.',409);
  const attempt=await io.read(d.slot);
  if(attempt?.id!==d.id) fail('The launch review does not match its saved attempt. Reload it.');
  return completed;
}
async function claimMint(root,io) {
  try {
    await io.createOnce('staged/mints/'+root.mint+'.json',{id:root.id},sameId);
  } catch {
    fail('This mint has another active launch. Resume its original receipt.',409);
  }
}
async function restoreSigned(id,io) {
  const saved=await io.read('signed/'+id+'.json');
  if(saved) return saved;
  const decision=await io.read(decisionKey(id));
  if(decision?.kind!=='signed') return null;
  return io.createOnce('signed/'+id+'.json',decision.saved,(a,b)=>a.signature===b.signature);
}
async function submissionDecision(d,candidate,io) {
  const proposed=io.now()>d.expiresAt?{kind:'expired'}:{kind:'signed',saved:candidate};
  try {
    return await io.createOnce(decisionKey(d.id),proposed,(a,b)=>a.kind===b.kind&&(a.kind==='expired'||a.saved.signature===b.saved.signature));
  } catch {
    const decision=await io.read(decisionKey(d.id));
    if(!['signed','expired'].includes(decision?.kind)) fail('This launch step could not be reconciled. Keep its signed receipt and retry.',503);
    return decision;
  }
}
export async function submitStaged(d,input,deps) {
  const io=ioFor(deps),root=await rootFor(d.launchId,io);
  if(!PHASES.includes(d.phase)||typeof input.wire!=='string'||input.wire.length>MAX_LAUNCH_BASE64) fail('Invalid signed launch step. Reload the saved review.');
  const wire=Buffer.from(input.wire,'base64');
  walletSignedLaunchMatches(Buffer.from(d.wire,'base64'),wire);
  const signature=cloutPaymentSignature(wire),prior=await restoreSigned(d.id,io);
  if(prior) return statusStaged(d,prior,true,io,signature);
  if(io.now()<=d.expiresAt) {
    await assertPhaseOpen(d,root,io);
    await claimMint(root,io);
  }
  const candidate={id:d.id,flow:STAGED_FLOW,launchId:root.id,phase:d.phase,signature,wire:input.wire,createdAt:io.now()};
  const decision=await submissionDecision(d,candidate,io);
  // An expired decision can retain late bytes for recovery, but can never authorize a send.
  const saved=await io.createOnce('signed/'+d.id+'.json',decision.kind==='signed'?decision.saved:candidate,sameId);
  await io.indexPending(saved);
  return statusStaged(d,saved,true,io,signature);
}
function phaseResult(root,completed,phase) {
  const result={launchId:root.id,phase,signature:completed[phase]?.signature,coin:completed.create?.coin};
  return {status:nextLaunchPhase(root,completed)?'phase-confirmed':'confirmed',...result};
}
export async function statusStaged(d,saved,broadcast,deps,requestedSignature) {
  const io=ioFor(deps);
  saved ||= await restoreSigned(d.id,io);
  if(!saved) fail('No signed launch step is saved. Resume submission of the original signed bytes.',404);
  if(requestedSignature!==undefined&&requestedSignature!==saved.signature) return {status:'canonical-signed',id:d.id,launchId:d.launchId,phase:d.phase,signature:saved.signature,wire:saved.wire};
  const root=await rootFor(d.launchId,io),completed=await completedPhases(root,io);
  if(completed[d.phase]) {await io.removePending(saved);return phaseResult(root,completed,d.phase);}
  const terminal=await io.read(outcomeKey(d.id));
  if(terminal) return terminal;
  const base={signature:saved.signature,mint:d.mint,launchId:root.id,phase:d.phase,created:!!completed.create};
  if((await io.read(decisionKey(d.id)))?.kind==='expired')
    return terminalOutcome(d,saved,{status:'expired',...base,error:'This review expired before submission and was never broadcast. Earlier completed phases remain; refresh only this phase.'},io);
  const observed=await chainStatus(saved,io);
  if(!observed) return {status:'checking',...base};
  return observedPhase(d,saved,{root,completed,base,...observed},broadcast,io);
}
async function chainStatus(saved,io) {
  const slot=await io.rpc.getSlot('finalized');
  const height=await io.rpc.getBlockHeight({commitment:'finalized',minContextSlot:slot});
  const statuses=await io.rpc.getSignatureStatuses([saved.signature],{searchTransactionHistory:true});
  if(!Number.isSafeInteger(height)||!Number.isSafeInteger(statuses?.context?.slot)||statuses.context.slot<slot||!Array.isArray(statuses?.value)||statuses.value.length!==1) return null;
  return {height,chain:statuses.value[0]};
}
async function observedPhase(d,saved,{root,completed,base,height,chain},broadcast,io) {
  if(chain?.confirmationStatus==='finalized') {
    if(chain.err) return terminalOutcome(d,saved,{status:'failed',...base,error:'This step failed onchain. Earlier completed steps remain; retry only this step.'},io);
    return finishPhase(d,saved,root,completed,io);
  }
  if(chain) return {status:'confirming',...base};
  if(height>d.lastValidBlockHeight) return terminalOutcome(d,saved,{status:'expired',...base,error:'This step expired before landing. Earlier completed steps remain; refresh only this step.'},io);
  if(!broadcast) {
    const blocked=await io.read('submission-checks/'+d.id+'.json');
    return blocked?{status:'blocked',...base,error:blocked.error}:{status:'checking',...base};
  }
  await assertPhaseOpen(d,root,io);
  await claimMint(root,io);
  return sendPhase(d,saved,base,io);
}
async function terminalOutcome(d,saved,result,io) {
  const stored=await io.createOnce(outcomeKey(d.id),result,(a,b)=>a.signature===b.signature&&a.status===b.status);
  await io.removePending(saved);
  return stored;
}
async function sendPhase(d,saved,base,io) {
  await io.checkNetwork(io.rpc,'mainnet');
  if(d.phase!=='buy') await requireRewards(d,io);
  let error;
  try {await preflightPhase(d,saved,io);} catch(e) {error=e.safe?e.message:'The signed step could not be verified. Keep its receipt and retry.';}
  if(error) {
    await io.createOnce('submission-checks/'+d.id+'.json',{signature:saved.signature,error},(a,b)=>a.signature===b.signature);
    return {status:'blocked',...base,error};
  }
  await io.createOnce('broadcasts/'+d.id+'.json',{id:d.id,signature:saved.signature,attemptedAt:io.now()},(a,b)=>a.signature===b.signature);
  const signature=await io.rpc.sendRawTransaction(Buffer.from(saved.wire,'base64'),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});
  if(signature!==saved.signature) fail('The RPC returned another signature. Keep checking the original receipt.',503);
  return {status:'submitted',...base};
}
async function preflightPhase(d,saved,io) {
  const tx=decodeLaunchTransaction(Buffer.from(saved.wire,'base64'));
  if(tx.message.version!==1) fail('This launch step uses an unexpected transaction version. Keep its receipt.');
  walletSignedLaunchMatches(Buffer.from(d.wire,'base64'),Buffer.from(saved.wire,'base64'));
  const before=await io.rpc.getBalanceAndContext(new PublicKey(d.creator),'confirmed');
  const tracked=d.phase==='buy'?await walletTokenState(io.rpc,d.creator,new Set(tx.message.staticAccountKeys.map(String))):[];
  const simulation=await io.rpc.simulateTransaction(tx,{sigVerify:true,commitment:'confirmed',minContextSlot:before.context.slot,innerInstructions:true,accounts:{encoding:'base64',addresses:d.simulationAddresses}});
  const debit=io.verifySimulation(d,simulation,before.value,tracked);
  if(simulation.context.slot<before.context.slot||debit>BigInt(d.estimatedSolRaw)) fail('The signed step exceeds its reviewed SOL budget. Keep its receipt.');
  const fee=(await io.rpc.getFeeForMessage(tx.message,'confirmed')).value;
  if(!Number.isSafeInteger(fee)||fee<0||fee>MAX_NETWORK_FEE) fail('The wallet fee exceeds the launch limit. Keep its receipt.');
}
async function verifiedReceipt(d,saved,io) {
  const tx=await io.readReceipt(io.rpc,saved.signature);
  if(!tx?.meta||tx.meta.err!==null) fail('Finalized receipt indexing is delayed. Keep checking the original signature.',503);
  const expected=decodeLaunchTransaction(Buffer.from(saved.wire,'base64')).message.serialize();
  if(!Buffer.from(expected).equals(Buffer.from(tx.transaction.message.serialize()))) fail('The receipt differs from the signed launch step. Keep its signature.');
  verifyReceiptDebit(d,tx);
  return tx;
}
function verifyReceiptDebit(d,tx) {
  const payer=tx.transaction.message.staticAccountKeys[0].toBase58();
  const before=tx.meta.preBalances?.[0],after=tx.meta.postBalances?.[0];
  if(payer!==d.creator||!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||after<0||after>=before) fail('The receipt debit could not be verified. Keep its signature.');
  if(BigInt(before-after)>BigInt(d.estimatedSolRaw)) fail('The receipt exceeds the reviewed debit. Keep its signature.');
}
async function finishPhase(d,saved,root,completed,io) {
  await io.checkNetwork(io.rpc,'mainnet');
  const tx=await verifiedReceipt(d,saved,io);
  let coin=completed.create?.coin;
  if(d.phase==='create') coin=await publishCreation(d,saved,root,completed,io);
  if(d.phase==='buy') {
    const bought=io.verifyBuyReceipt(tx,d);
    if(BigInt(bought)<BigInt(d.minimumTokensRaw)) fail('The initial buy receipt is below its approved minimum. Keep its signature.');
    if(d.atomicSolBuy) io.verifyConversionReceipt(tx,{...d,devBuyRaw:'0'});
  }
  const row={id:d.id,signature:saved.signature,phase:d.phase,slot:tx.slot,coin};
  completed[d.phase]=await io.createOnce(completedKey(root,d.phase),row,(a,b)=>a.signature===b.signature);
  await io.removePending(saved);
  return phaseResult(root,completed,d.phase);
}
async function publishCreation(d,saved,root,completed,io) {
  await io.verifyFees(io.rpc,root.mint,root.feeTreasury,NEAR,root.creatorFeeBps);
  const mintKey=new PublicKey(root.mint),info=await io.rpc.getAccountInfo(mintKey,'finalized');
  if(!info?.owner.equals(TOKEN_2022_PROGRAM_ID)) fail('The created mint could not be verified. Keep its signature.');
  const mint=unpackMint(mintKey,info,TOKEN_2022_PROGRAM_ID);
  if(mint.decimals!==6||mint.freezeAuthority!==null) fail('The created mint differs from the reviewed token. Keep its signature.');
  const record={...root,signature:saved.signature,settlementSignatures:[completed.setup.signature,saved.signature],verifiedAt:new Date(io.now()).toISOString(),supply:mint.supply.toString(),decimals:mint.decimals};
  delete record.image;
  await io.createOnce('receipts/'+root.mint+'.json',record,(a,b)=>a.signature===b.signature);
  return publicCoin(record);
}
