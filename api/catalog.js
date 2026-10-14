import {VENUE,NEAR_PAIR,cleanToken} from '../lib/catalog.js';
let cache,expires=0;
export default async function handler(req,res){
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 const send=(code,data)=>{res.statusCode=code;res.end(JSON.stringify(data));};
 if(req.method!=='GET'){res.setHeader('Allow','GET');return send(405,{error:'Method not allowed'});}
 try{if(Date.now()<expires)return send(200,cache);
 const read=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('Provider unavailable');return r.json();};
 const [catalog,pairs,routing]=await Promise.allSettled([read(`${VENUE}/api/public/v1/tokens?quoteMint=${NEAR_PAIR}&pageSize=100&sort=marketCap`),read(`${VENUE}/api/public/v1/pairs?launchable=true&launchLabReady=true`),read('https://1click.chaindefuser.com/v0/tokens')]);
 if(catalog.status!=='fulfilled'||!Array.isArray(catalog.value?.data?.tokens))return send(503,{error:'The live market directory is unavailable. Retry shortly.'});
 const routeAssets=routing.status==='fulfilled'&&Array.isArray(routing.value)?routing.value:null;
 const pair=pairs.status==='fulfilled'?pairs.value?.data?.pairs?.find(p=>p.mint===NEAR_PAIR):null;
 cache={tokens:catalog.value.data.tokens.map(t=>cleanToken(t,routeAssets)).filter(Boolean),observedAt:new Date().toISOString(),source:'StonkFun public API',coverage:'First 100 NEAR-paired markets ordered by market cap',pair:{mint:NEAR_PAIR,symbol:'NEAR',network:'Solana',launchable:pair?pair.launchable===true&&pair.launchLabReady===true:null},routingCatalogAvailable:routeAssets!==null,launchExecution:'external-venue',launchUrl:`${VENUE}/launch`,nativeLaunchEnabled:false};expires=Date.now()+30000;return send(200,cache);
 }catch{return send(503,{error:'Could not load the market directory. No sample markets are substituted.'});}
}
