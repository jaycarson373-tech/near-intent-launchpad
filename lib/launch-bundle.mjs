import {createHash} from 'node:crypto';
import {PublicKey,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {compileLaunchV1,decodeLaunchTransaction} from './launch-wire.mjs';
import {compactTokenSetup,WALLET_INSTRUCTION_ALLOWANCE} from './launch-budget.mjs';
import {walletSignedLaunchMatches,cloutPaymentSignature} from './launch-signatures.mjs';
import {fail,redact} from './http.js';

export const JITO_URL='https://mainnet.block-engine.jito.wtf/api/v1/bundles';
export const BUNDLE_TIP_LAMPORTS=10000;
const MEMO=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const BUY=createHash('sha256').update('global:buy_exact_quote_in_v3').digest().subarray(0,8);
const memo=text=>new TransactionInstruction({programId:MEMO,keys:[],data:Buffer.from(text)});
let cachedTips;
export async function jitoRequest(method,params,{transport=fetch}={}){
  const response=await transport(JITO_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)fail('The atomic launch relay is busy. Keep your saved review and retry.',503);
  const body=await response.json();
  if(body.error||body.result===undefined)fail('The atomic launch relay could not accept this request. Keep your saved review.',503);
  return body.result;
}
export async function tipAccount(){
  if(!cachedTips||cachedTips.expires<Date.now()){
    const keys=await jitoRequest('getTipAccounts',[]);
    if(!Array.isArray(keys)||keys.length!==8||new Set(keys).size!==8||keys.some(k=>{try{return new PublicKey(k).equals(PublicKey.default)}catch{return true}}))fail('The launch relay tip accounts could not be verified.',503);
    cachedTips={keys,expires:Date.now()+300000};
  }
  return cachedTips.keys[0];
}

// Account rent, creation+immutable fee assignment, and swap+buy are distinct
// transactions in ONE bundle. The swap never has an independently submitted leg.
export function partitionLaunch({launch,route=[],mint,payer,tip}){
  const ata=ix=>ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID);
  const base=ix=>ata(ix)&&ix.keys[3].pubkey.equals(mint);
  const buy=ix=>ix.programId.toBase58()==='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'&&ix.data.subarray(0,8).equals(BUY);
  const buys=launch.filter(buy);
  if(buys.length>1||(route.length&&buys.length!==1))fail('The bundle does not contain exactly its reviewed initial buy.');
  const groups=[
    [...route,...launch].filter(ix=>ata(ix)&&!base(ix)),
    launch.filter(ix=>!ata(ix)&&!buy(ix)),
    [...route.filter(ix=>!ata(ix)),...launch.filter(ix=>base(ix)||buy(ix))],
  ];
  if(!groups[2].length)groups.pop();
  groups.at(-1).push(SystemProgram.transfer({fromPubkey:payer,toPubkey:new PublicKey(tip),lamports:BUNDLE_TIP_LAMPORTS}));
  return groups;
}

export async function simulateLaunchBundle(rpc,wires,addresses,{signed=false}={}){
  const response=await rpc._rpcRequest('simulateBundle',[
    {encodedTransactions:wires},
    {skipSigVerify:!signed,replaceRecentBlockhash:false,transactionEncoding:'base64',simulationBank:{commitment:{commitment:'confirmed'}},
      preExecutionAccountsConfigs:wires.map((_,i)=>i===0?{addresses}:null),
      postExecutionAccountsConfigs:wires.map((_,i)=>i===wires.length-1?{addresses}:null)},
  ]);
  if(response.error){
    console.error(JSON.stringify({service:'intent-pad-api',bundleSimulationUnavailable:redact(response.error.message)}));
    fail('The RPC could not simulate the complete launch bundle. Keep the original review and signatures.',503);
  }
  const value=response.result?.value,results=value?.transactionResults;
  if(!Number.isSafeInteger(response.result?.context?.slot)||!Array.isArray(results)||results.length!==wires.length||value.summary!=='succeeded'||results.some(r=>r.err!==null||!Array.isArray(r.logs))){
    console.error(JSON.stringify({service:'intent-pad-api',bundleSimulationFailed:redact(JSON.stringify(value?.summary)),errors:results?.map(r=>r.err),logs:results?.filter(r=>r.err).flatMap(r=>(r.logs||[]).slice(-8).map(redact))}));
    fail('The complete launch bundle did not pass simulation. Check your SOL balance and the original launch receipts.',503);
  }
  const before=results[0].preExecutionAccounts,after=results.at(-1).postExecutionAccounts;
  if(!Array.isArray(before)||before.length!==addresses.length||!Array.isArray(after)||after.length!==addresses.length||results.some(r=>!Number.isSafeInteger(r.fee)||r.fee<0||r.fee>500000))
    fail('The RPC did not return complete launch account and network-fee checks.',503);
  return {slot:response.result.context.slot,before,after,results};
}

export async function buildLaunchBundle({rpc,payer,mint,launch,route,latest,tip}){
  const groups=partitionLaunch({launch,route,mint,payer,tip});
  groups[0]=await compactTokenSetup(groups[0],rpc);
  if(!groups[0].length)groups[0].push(memo('INTENTPAD:account-setup-already-complete'));
  const compile=g=>compileLaunchV1({payer,latest,instructions:g,computeUnitLimit:1400000});
  const wires=groups.map(g=>Buffer.from(compile(g).serialize()).toString('base64'));
  // A real sequential bundle simulation, padded with non-financial Memo calls,
  // proves capacity for the 21 wallet security checks in the failing HAR.
  const capacityWires=groups.map(g=>Buffer.from(compile([...Array.from({length:WALLET_INSTRUCTION_ALLOWANCE},()=>memo('wallet capacity check')),...g]).serialize()).toString('base64'));
  return {wires,capacityWires,creationIndex:1,tipLamports:String(BUNDLE_TIP_LAMPORTS)};
}

export function verifySignedBundle(d,wires){
  if(!Array.isArray(wires)||wires.length!==d.wires.length||wires.some(w=>typeof w!=='string'||w.length>5500))fail('The wallet returned an incomplete launch bundle. Nothing was submitted.');
  try{wires.forEach((wire,i)=>walletSignedLaunchMatches(Buffer.from(d.wires[i],'base64'),Buffer.from(wire,'base64')))}
  catch{fail('The wallet changed or incompletely signed the launch bundle. Nothing was submitted.')}
  const signatures=wires.map(w=>cloutPaymentSignature(Buffer.from(w,'base64')));
  if(new Set(signatures).size!==signatures.length)fail('Duplicate transaction in the launch bundle.');
  return {signatures,signature:signatures[d.creationIndex],wire:wires[d.creationIndex],wires};
}

export function messageMatchesReceipt(wire,receipt){
  const expected=decodeLaunchTransaction(Buffer.from(wire,'base64')).message.serialize(),actual=receipt.transaction.message.serialize();
  return expected.length===actual.length&&expected.every((v,i)=>v===actual[i]);
}

export function bundleProgress(states,{expired=false,mintExists=false}={}){
  if(!states.length)fail('The bundle signature lookup was incomplete.',503);
  if(states.every(s=>s?.confirmationStatus==='finalized'&&!s.err))return 'finalized';
  if(states.some(s=>s&&!s.err))return expired||states.some(s=>s?.err)?'reconciling':'confirming';
  if(expired)return mintExists?'reconciling':states.some(s=>s?.err)?'failed':'review';
  return states.some(s=>s?.err)?'reconciling':'unseen';
}
