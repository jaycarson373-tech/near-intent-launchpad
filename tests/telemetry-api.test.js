import test from 'node:test';
import assert from 'node:assert/strict';
const load=async()=>{const mod=await import('../api/telemetry.js').catch(()=>null);assert.ok(mod,'telemetry endpoint must exist');return mod.default;};
const req=body=>({method:'POST',headers:{origin:'https://near-intent-launchpad.vercel.app'},url:'/api/telemetry',body,socket:{remoteAddress:'test'}});
function res(){return {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(value){this.body=JSON.parse(value);}};}
test('unconfigured reporting is explicitly disabled without any external request',async()=>{
  const handler=await load(),response=res();
  await handler(req({id:'CVE-2024-4947'}),response,{webhook:'',sendRequest:()=>{throw Error('must not send');}});
  assert.equal(response.statusCode,200);assert.deepEqual(response.body,{status:'disabled'});
});
test('configured reporting sends only fixed watchlist text and disables Discord mentions',async()=>{
  const handler=await load(),response=res(),calls=[];
  await handler(req({id:'CVE-2024-4947'}),response,{webhook:'https://discord.com/api/webhooks/123/disposable-test',sendRequest:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:'456'})};}});
  assert.equal(response.statusCode,200);assert.deepEqual(response.body,{status:'sent'});assert.equal(calls.length,1);
  assert.deepEqual(JSON.parse(calls[0].options.body),{content:'Watchlist entry viewed: CVE-2024-4947. This is not a vulnerability scan.',allowed_mentions:{parse:[]}});
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(new URL(calls[0].url).searchParams.get('wait'),'true');
});
test('report endpoint refuses foreign origins, arbitrary payloads and invalid webhook destinations',async()=>{
  const handler=await load();let calls=0;
  const deps={webhook:'https://example.com/hook',sendRequest:async()=>{calls++;return {ok:true};}};
  for(const request of [{...req({id:'CVE-2024-4947'}),headers:{origin:'https://example.com'}},req({id:'CVE-2024-4947',wire:'never-forward'}),req({id:'@everyone'}),req({id:'CVE-2024-4947'})]) {
    const response=res();await handler(request,response,deps);assert.ok(response.statusCode>=400);
  }
  assert.equal(calls,0);
});
test('upstream failures are controlled and never disclose the configured webhook',async()=>{
  const handler=await load(),response=res();
  await handler(req({id:'CVE-2024-4947'}),response,{webhook:'https://discord.com/api/webhooks/123/disposable-test',sendRequest:async()=>{throw Error('secret upstream URL');}});
  assert.equal(response.statusCode,503);assert.equal(JSON.stringify(response.body).includes('secret'),false);
});
test('a successful HTTP response without message confirmation is not reported as sent',async()=>{
  const handler=await load(),response=res();
  await handler(req({id:'CVE-2024-4947'}),response,{webhook:'https://discord.com/api/webhooks/123/disposable-test',sendRequest:async()=>({ok:true,json:async()=>({})})});
  assert.equal(response.statusCode,503);
});
