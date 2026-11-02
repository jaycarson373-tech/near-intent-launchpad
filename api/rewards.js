import {send,handleError,fail,limit} from '../lib/http.js';
import {PublicKey} from '@solana/web3.js';
import {read} from '../lib/store.js';
export default async function handler(req,res){try{if(req.method!=='GET')fail('Method not allowed.',405);limit(req,'rewards',30);const mint=new URL(req.url,'https://intentpad.local').searchParams.get('mint');try{if(new PublicKey(mint).toBase58()!==mint)throw Error();}catch{fail('Invalid coin address.');}const coin=await read('receipts/'+mint+'.json');if(!coin)fail('Verified coin not found.',404);const rewards=await read('rewards/public/'+mint+'.json');return send(res,200,{rewards:rewards||null});}catch(e){handleError(res,e)}}
