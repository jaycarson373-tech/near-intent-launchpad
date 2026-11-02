import {Connection,PublicKey} from '@solana/web3.js';
export const SOL='So11111111111111111111111111111111111111112';
export const NEAR='3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG';
export const GENESIS={mainnet:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'};
export const publicKey=value=>new PublicKey(value);
let rpc;
export function connection(){const url=process.env.SOLANA_RPC_URL||'https://api.mainnet-beta.solana.com';if(!url.startsWith('https://'))throw Error('An HTTPS mainnet RPC is required.');return rpc??=new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})})}
