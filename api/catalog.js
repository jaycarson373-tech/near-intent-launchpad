let cache, expires=0;
export default async function handler(req,res){
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 const send=(status,data)=>{res.statusCode=status;res.end(JSON.stringify(data))};
 if(req.method!=='GET')return send(405,{error:'Method not allowed'});
 try{if(Date.now()<expires)return send(200,cache);const response=await fetch('https://1click.chaindefuser.com/v0/tokens',{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error();const data=await response.json();if(!Array.isArray(data))throw new Error();cache={network:'NEAR',source:'1Click supported-asset directory',observedAt:new Date().toISOString(),tokens:data.filter(t=>t.blockchain==='near'&&typeof t.contractAddress==='string').map(t=>({mint:t.contractAddress,name:t.symbol,symbol:t.symbol,assetId:t.assetId,price:Number.isFinite(t.price)&&t.price>0?t.price:null,updatedAt:t.priceUpdatedAt||null,status:'supported',marketCap:null,volume:null,change:null})),nativeLaunchEnabled:true};expires=Date.now()+60000;return send(200,cache)}catch{return send(503,{error:'NEAR token directory unavailable. Refresh to retry.'})}
}
