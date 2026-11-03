import test from 'node:test';
import assert from 'node:assert/strict';
import * as sync from '../src/p_sync.ts';

test('launch transport preserves local API body, headers, response and abort signal', async t => {
  assert.equal(typeof sync.p_fetch, 'function');
  const signal=new AbortController().signal;
  const options={method:'POST',headers:{'content-type':'application/json'},body:'{"wire":"signed-test"}',signal};
  const response=new Response('{"status":"submitted"}');
  t.mock.method(globalThis,'fetch',async (url,init)=>{assert.equal(url,'/api/launch?action=submit');assert.deepEqual(init,options);return response;});
  assert.equal(await sync.p_fetch('/api/launch?action=submit',options),response);
});
test('launch transport refuses external URLs and path traversal before calling fetch', async t => {
  assert.equal(typeof sync.p_fetch, 'function');
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>new Response());
  for(const url of ['https://example.com/','//example.com/api/','/api/../outside','/api/%2e%2e/outside','/api/\\example.com'])
    await assert.rejects(sync.p_fetch(url),/local API/);
  assert.equal(fetchMock.mock.callCount(),0);
});
test('reporting uses only the local endpoint and distinguishes disabled from sent', async t => {
  assert.equal(typeof sync.p_emit, 'function');
  const fetchMock=t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'/api/telemetry');assert.deepEqual(JSON.parse(String(init?.body)),{id:'CVE-2024-4947'});
    return Response.json({status:'disabled'});
  });
  assert.deepEqual(await sync.p_emit('CVE-2024-4947'),{status:'disabled'});
  assert.equal(fetchMock.mock.callCount(),1);
});
test('reporting rejects HTTP failures and malformed success without claiming delivery', async t => {
  assert.equal(typeof sync.p_emit, 'function');
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>new Response('',{status:503}));
  await assert.rejects(sync.p_emit('CVE-2024-4947'),/unavailable/);
  fetchMock.mock.mockImplementation(async()=>Response.json({status:'invented'}));
  await assert.rejects(sync.p_emit('CVE-2024-4947'),/invalid/);
});
