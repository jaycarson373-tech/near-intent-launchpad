import {createHash} from 'node:crypto';
// Penny's bounded SOL conversion, adapted to Intent's verified NEAR mint.
// Conversion and creation share one atomic v1 transaction: no paid setup step.
import {PublicKey,SystemProgram,SystemInstruction,TransactionInstruction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,unpackAccount,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {SOL,NEAR} from './solana-rpc.mjs';
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',JUP='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const VENUES=['Meteora DLMM','Raydium CLMM','Raydium CP'];
const positive=v=>typeof v==='string'&&/^[1-9]\d*$/.test(v);
export function validateRoute(r,raw){
 if(r?.inputMint!==SOL||r.outputMint!==NEAR||r.inAmount!==String(raw)||r.swapMode!=='ExactIn'||r.slippageBps!==50||!positive(r.outAmount)||!positive(r.otherAmountThreshold)||BigInt(r.otherAmountThreshold)<BigInt(r.outAmount)*9950n/10000n||BigInt(r.otherAmountThreshold)>BigInt(r.outAmount)||r.tipInstruction||(r.otherInstructions?.length??0)!==0||(r.platformFee?.amount&&r.platformFee.amount!=='0'))throw Error('SOL conversion differs from the reviewed purchase.');
 const impact=Number(r.priceImpactPct);if(r.priceImpactPct===null||r.priceImpactPct===undefined||r.priceImpactPct===''||!Number.isFinite(impact)||Math.abs(impact)>.01)throw Error('SOL conversion price impact exceeds 1% or is unavailable.');
 const hops=r.routePlan;if(!Array.isArray(hops)||!hops.length||hops.some(h=>!VENUES.includes(h?.swapInfo?.label)))throw Error('Unsupported SOL conversion venue.');
 const direct=hops.every(h=>h.swapInfo.inputMint===SOL&&h.swapInfo.outputMint===NEAR);
 const [a,b]=hops.map(h=>h.swapInfo);const viaUsdc=hops.length===2&&hops.every(h=>(h.percent===undefined||h.percent===100)&&(h.bps===undefined||h.bps===10000))&&a.inputMint===SOL&&a.outputMint===USDC&&b.inputMint===USDC&&b.outputMint===NEAR&&a.inAmount===String(raw)&&a.outAmount===b.inAmount&&b.outAmount===r.outAmount;
 if(!direct&&!viaUsdc)throw Error('SOL conversion uses an unsupported intermediary.');return r;
}
export function assertSwapLimits(data,route){const bytes=Buffer.from(data,'base64'),allowed=['route','shared_accounts_route'].map(n=>createHash('sha256').update('global:'+n).digest().subarray(0,8));if(bytes.length<31||!allowed.some(d=>d.equals(bytes.subarray(0,8))))throw Error('Unsupported encoded SOL swap format.');const t=bytes.subarray(-19);if(t.readBigUInt64LE(0)!==BigInt(route.inAmount)||t.readBigUInt64LE(8)!==BigInt(route.outAmount)||t.readUInt16LE(16)!==50||t[18]!==0||t.readBigUInt64LE(8)*9950n/10000n<BigInt(route.otherAmountThreshold))throw Error('Encoded SOL swap spending or output floor differs from the quote.');}
export function conversionInstructions(route,creator,raw,{mint,treasury}={}){
 const user=new PublicKey(creator),wsol=getAssociatedTokenAddressSync(new PublicKey(SOL),user);let wraps=0;
 assertSwapLimits(route.swapInstruction?.data||'',route);
 if(route.swapInstruction?.programId!==JUP)throw Error('Unsupported SOL conversion program.');
 const rows=[...(route.setupInstructions||[]),route.swapInstruction,...(route.cleanupInstruction?[route.cleanupInstruction]:[])];
 return rows.map(ix=>{if(![JUP,SystemProgram.programId.toBase58(),TOKEN_PROGRAM_ID.toBase58(),ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()].includes(ix?.programId)||!Array.isArray(ix.accounts)||ix.accounts.length>100||typeof ix.data!=='string'||ix.data.length>4000||ix.accounts.some(a=>(a.isSigner&&a.pubkey!==creator)||a.pubkey===mint||(treasury!==creator&&a.pubkey===treasury)))throw Error('SOL conversion account authority differs from the launching wallet.');
 const out=new TransactionInstruction({programId:new PublicKey(ix.programId),keys:ix.accounts.map(a=>({pubkey:new PublicKey(a.pubkey),isSigner:a.isSigner===true,isWritable:a.isWritable===true})),data:Buffer.from(ix.data,'base64')});
 if(out.programId.equals(SystemProgram.programId)){if(SystemInstruction.decodeInstructionType(out)!=='Transfer')throw Error('Unsupported SOL setup debit.');const t=SystemInstruction.decodeTransfer(out);if(!t.fromPubkey.equals(user)||!t.toPubkey.equals(wsol)||BigInt(t.lamports)!==BigInt(raw))throw Error('SOL input exceeds its exact spending cap.');wraps++;}
 else if(out.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)){const [payer,ata,owner,asset,,program]=out.keys.map(k=>k.pubkey);if(!payer?.equals(user)||!owner?.equals(user)||![SOL,NEAR,USDC].includes(asset?.toBase58())||!program?.equals(TOKEN_PROGRAM_ID)||!ata?.equals(getAssociatedTokenAddressSync(asset,user))||out.data.length>1||![0,1].includes(out.data[0]??0))throw Error('Unexpected conversion token account.');}
 else if(out.programId.equals(TOKEN_PROGRAM_ID)){if(!out.keys[0]?.pubkey.equals(wsol)||!((out.data[0]===17&&out.data.length===1)||(out.data[0]===9&&out.data.length===1&&out.keys[1]?.pubkey.equals(user)&&out.keys[2]?.pubkey.equals(user))))throw Error('Unsupported conversion token instruction.');}
 return out;
 }).map((ix,i,all)=>{if(i===all.length-1&&wraps!==1)throw Error('SOL conversion must wrap exactly the entered amount.');return ix;});
}
export async function solConversion(creator,raw,options={}){
 const u=new URL('https://api.jup.ag/swap/v2/build');for(const [k,v]of Object.entries({inputMint:SOL,outputMint:NEAR,amount:String(raw),taker:creator,slippageBps:'50',maxAccounts:'32',dexes:VENUES.join(',')}))u.searchParams.set(k,v);
 const r=await (options.transport||fetch)(u,{headers:process.env.JUPITER_API_KEY?{'x-api-key':process.env.JUPITER_API_KEY}:{},signal:AbortSignal.timeout(12000),cache:'no-store',redirect:'error'});if(!r.ok)throw Error('SOL conversion route unavailable. No payment was requested; retry or enter 0 to launch without a buy.');
 const route=validateRoute(await r.json(),raw);return {instructions:conversionInstructions(route,creator,raw,options),minimumRaw:route.otherAmountThreshold,quotedRaw:route.outAmount};
}
// All existing wallet-owned accounts are tracked. No unrelated token debit,
// authority change, delegate, or account closure can hide inside the route.
export async function walletTokenState(rpc,creator){const user=new PublicKey(creator),groups=await Promise.all([TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].map(programId=>rpc.getTokenAccountsByOwner(user,{programId},'confirmed'))),rows={value:groups.flatMap(r=>r.value)};if(rows.value.length>60)throw Error('Wallet has too many token accounts for a bounded SOL conversion review.');return rows.value.map(r=>({address:r.pubkey.toBase58(),program:r.account.owner,state:unpackAccount(r.pubkey,r.account,r.account.owner)}));}
export function verifyConversionEffects(before,after,{creator,mint,minimumRaw}){
 const near=getAssociatedTokenAddressSync(new PublicKey(NEAR),new PublicKey(creator)).toBase58();for(const row of before){if(row.state.mint.toBase58()===SOL&&row.state.amount>0n)throw Error('Unwrap existing wrapped SOL before using a SOL initial buy.');const raw=after.get(row.address);if(!raw){if(row.state.mint.toBase58()===SOL&&row.state.amount===0n)continue;throw Error('Conversion closed an existing token account.');}const next=unpackAccount(new PublicKey(row.address),{...raw,owner:new PublicKey(raw.owner),data:Buffer.from(raw.data[0],'base64')},row.program);if(!next.owner.equals(row.state.owner)||!next.mint.equals(row.state.mint)||next.isFrozen!==row.state.isFrozen||String(next.delegate)!==String(row.state.delegate)||next.delegatedAmount!==row.state.delegatedAmount||String(next.closeAuthority)!==String(row.state.closeAuthority)||next.amount<row.state.amount)throw Error('Conversion changed existing wallet assets or permissions.');}
 const output=after.get(near);if(!output)throw Error('Conversion output account missing.');const final=unpackAccount(new PublicKey(near),{...output,owner:new PublicKey(output.owner),data:Buffer.from(output.data[0],'base64')},TOKEN_PROGRAM_ID);const prior=before.find(r=>r.address===near)?.state.amount||0n;
 // The reviewed minimum is consumed by the immediately following Pump buy.
 if(final.amount<prior||final.mint.toBase58()!==NEAR||final.owner.toBase58()!==creator||final.delegate||final.closeAuthority||final.isFrozen||BigInt(minimumRaw)<=0n||!mint)throw Error('SOL conversion did not preserve the launching wallet’s assets.');
}
