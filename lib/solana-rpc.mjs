import {Connection,PublicKey} from '@solana/web3.js';
export const SOL='So11111111111111111111111111111111111111112';
export const NEAR='3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG';
export const GENESIS={mainnet:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'};
export const publicKey=value=>new PublicKey(value);
let rpc;
// Load-balanced RPCs (Helius) can route a minContextSlot request to a node a slot or two behind the one that
// answered the previous call: JSON-RPC error -32016. Resend that exact request a few times; nothing else retries.
const MIN_SLOT_NOT_REACHED=/"code"\s*:\s*-32016\b/;
export async function rpcFetch(input,init,{base=fetch,attempts=5,delayMs=400}={}){
 for(let i=1;;i++){
  const r=await base(input,{...init,signal:AbortSignal.timeout(20000)});
  const text=await r.text();
  if(i>=attempts||!MIN_SLOT_NOT_REACHED.test(text))return new Response(text,{status:r.status,statusText:r.statusText,headers:{'content-type':r.headers.get('content-type')||'application/json'}});
  await new Promise(done=>setTimeout(done,delayMs*i));
 }
}
export function connection(){const url=process.env.SOLANA_RPC_URL||'https://api.mainnet-beta.solana.com';if(!url.startsWith('https://'))throw Error('An HTTPS mainnet RPC is required.');return rpc??=new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(input,init)=>rpcFetch(input,init)})}
