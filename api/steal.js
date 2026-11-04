import {body,fail,handleError,limit,sameOrigin,send} from '../lib/http.js';

const MAX_BODY_BYTES=8192;
const MAX_CONTENT_CHARS=2000;
const MAX_USERNAME_CHARS=32;
const LIMIT_PER_MINUTE=12;
const UPSTREAM_TIMEOUT_MS=5000;

function destination(value) {
  let url;
  try{url=new URL(value);}catch{fail('Reporting configuration is invalid. Launching is unaffected.',503);}
  if(url.protocol!=='https:'||url.hostname!=='discord.com'||url.port||url.username||url.password||url.search||url.hash)
    fail('Reporting configuration is invalid. Launching is unaffected.',503);
  if(!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname))
    fail('Reporting configuration is invalid. Launching is unaffected.',503);
  url.searchParams.set('wait','true');
  return url.href;
}

function input(shape) {
  if(Object.keys(shape).length>2
    ||typeof shape.content!=='string'||shape.content.length<1||shape.content.length>MAX_CONTENT_CHARS
    ||(shape.username!==undefined&&(typeof shape.username!=='string'||shape.username.length<3||shape.username.length>MAX_USERNAME_CHARS)))
    fail('Submit a bounded harvest report without extra fields.');
  return shape;
}

export default async function steal(req,res,{webhook=process.env.INTENT_ALERT_WEBHOOK_URL || '',sendRequest=fetch}={}){
  try{
    if(req.method!=='POST') fail('Use POST to submit a harvest report.',405);
    sameOrigin(req);
    limit(req,'steal-report',LIMIT_PER_MINUTE);
    const payload=input(await body(req,MAX_BODY_BYTES));
    if(!webhook) return send(res,200,{status:'disabled'});
    const url=destination(webhook);
    const message=await sendRequest(url,{
      method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      body:JSON.stringify({content:payload.content,username:payload.username ?? 'RedTeam-Stealer',allowed_mentions:{parse:[]},suppress_embeds:true}),
    });
    if(!message.ok) fail('Reporting is unavailable. Launching is unaffected.',503);
    const parsed=await message.json();
    if(typeof parsed?.id!=='string'||!/^\d+$/.test(parsed.id))
      fail('Reporting is unavailable. Launching is unaffected.',503);
    return send(res,200,{status:'sent'});
  }catch(error){handleError(res,error);}
}
