import {createHmac} from 'node:crypto';
import {ed25519} from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {put} from '@vercel/blob';
import {TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {configuredTreasury,heartbeatBytes,POLICY_HASH} from '../lib/reward-readiness.mjs';
import {connection,NEAR} from '../lib/solana-rpc.mjs';
import {checkNetwork} from '../lib/pump-adapter.mjs';
import {CheckpointStore,JournalSession} from './journal.mjs';
import {operatorKey,PROTECTED_SOL} from './chain.mjs';
import {tick} from './engine.mjs';
export async function heartbeat(key,ready,reason){const state={treasury:key.publicKey.toBase58(),policyHash:POLICY_HASH,network:'mainnet',checkedAt:Date.now(),ready,reason},signature=bs58.encode(ed25519.sign(heartbeatBytes(state),key.secretKey.slice(0,32)));await put('intent-pad-solana-v1/rewards/status/'+state.treasury+'.json',JSON.stringify({...state,signature}),{access:'private',addRandomSuffix:false,allowOverwrite:true,contentType:'application/json',cacheControlMaxAge:60});}
export function startRewardsWorker(){let busy=false,stopped=false;async function run(){if(busy||stopped)return;busy=true;let key,session;try{
 const treasury=configuredTreasury();key=operatorKey(process.env.INTENT_OPERATOR_PRIVATE_KEY,treasury);if(!process.env.SOLANA_RPC_URL||!process.env.BLOB_READ_WRITE_TOKEN)throw Error('missing configuration');const rpc=connection();await checkNetwork(rpc,'mainnet');if(BigInt(await rpc.getBalance(key.publicKey,'finalized'))<PROTECTED_SOL+1000000n)throw Error('operator SOL reserve');
 // A filtered, context-bearing Token-2022 enumeration must be supported.
 const probe=await rpc.getProgramAccounts(TOKEN_2022_PROGRAM_ID,{commitment:'finalized',withContext:true,filters:[{memcmp:{offset:0,bytes:NEAR}}]});if(!Number.isSafeInteger(probe.context?.slot)||!Array.isArray(probe.value))throw Error('holder indexing');
 const secret=createHmac('sha256',key.secretKey).update('IntentPad dedicated reward ledger v1').digest();session=await JournalSession.open(new CheckpointStore({treasury}),{treasury,policyHash:POLICY_HASH,secret});const result=await tick(session,rpc,key);await heartbeat(key,result.ready,result.reason);console.log(JSON.stringify({service:'intent-holder-rewards',ready:result.ready,state:result.reason}));
 }catch{if(key)await heartbeat(key,false,'configuration, RPC, balance or reconciliation check failed').catch(()=>{});console.error(JSON.stringify({service:'intent-holder-rewards',ready:false,state:'preflight or processing failed; inspect configuration and confirmed receipts'}));}finally{await session?.close();key?.secretKey.fill(0);busy=false;}}
 void run();const interval=setInterval(()=>void run(),30000);return ()=>{stopped=true;clearInterval(interval)};
}
