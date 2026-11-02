import type {PublicKey,TransactionInstruction,VersionedTransaction,Connection} from '@solana/web3.js';
export const MAX_LAUNCH_BASE64:number;
export function decodeLaunchTransaction(wire:Uint8Array):VersionedTransaction;
export function compileLaunchV1(input:{payer:PublicKey;latest:{blockhash:string;lastValidBlockHeight:number};instructions:TransactionInstruction[];computeUnitLimit?:number;loadedAccountsDataSizeLimit?:number;priorityFeeLamports?:bigint}):VersionedTransaction;
export function readLaunchReceipt(rpc:Connection,signature:string):Promise<unknown>;
