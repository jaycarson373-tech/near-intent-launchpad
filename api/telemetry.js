import {body,fail,handleError,limit,sameOrigin,send} from '../lib/http.js';

const MAX_REPORT_BYTES=256;
const REPORTS_PER_MINUTE=12;
const UPSTREAM_TIMEOUT_MS=5000;
const CVE_ID=/^CVE-\d{4}-\d{4,10}$/;

function destination(value) {
  let url;
  try {url=new URL(value);} catch {fail('Reporting configuration is invalid. Launching is unaffected.',503);}
  if(url.protocol!=='https:'||url.hostname!=='discord.com'||url.port||url.username||url.password||url.search||url.hash)
    fail('Reporting configuration is invalid. Launching is unaffected.',503);
  if(!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname))
    fail('Reporting configuration is invalid. Launching is unaffected.',503);
  url.searchParams.set('wait','true');
  return url.href;
}

async function deliver(url,id,sendRequest) {
  try {
    const response=await sendRequest(url,{
      method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      body:JSON.stringify({content:`Watchlist entry viewed: ${id}. This is not a vulnerability scan.`,allowed_mentions:{parse:[]}}),
    });
    if(response.ok) {
      const message=await response.json();
      if(typeof message?.id==='string'&&/^\d+$/.test(message.id)) return;
    }
  } catch { /* Return the same controlled error for network and upstream failures. */ }
  fail('Reporting is unavailable. Launching is unaffected.',503);
}

function reportId(input) {
  if(Object.keys(input).length!==1||typeof input.id!=='string'||!CVE_ID.test(input.id))
    fail('Submit one watchlist ID without wallet data or message content.');
  return input.id;
}

export default async function telemetry(req,res,{webhook=process.env.INTENT_ALERT_WEBHOOK_URL || '', sendRequest=fetch}={}){
  try {
    if(req.method!=='POST') fail('Use POST to submit a watchlist report.',405);
    sameOrigin(req);
    limit(req,'watchlist-report',REPORTS_PER_MINUTE);
    const id=reportId(await body(req,MAX_REPORT_BYTES));
    if(!webhook) return send(res,200,{status:'disabled'});
    const url=destination(webhook);
    await deliver(url,id,sendRequest);
    return send(res,200,{status:'sent'});
  } catch(error) {handleError(res,error);}
}
