import test from "node:test";
import assert from "node:assert/strict";
import { jitoTipAccount, sendJitoBundle, jitoBundleStatus, resetJitoCache, JITO_TIP_LAMPORTS } from "../lib/jito.mjs";

const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tips = ["DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT", "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"];

test("tip account is picked from Jito's list and cached", async () => {
  resetJitoCache();
  let calls = 0;
  const fetch = async (...a) => (calls++, reply({ jsonrpc: "2.0", id: 1, result: tips })(...a));
  assert.equal(await jitoTipAccount({ fetch, random: () => 0.99, now: 1 }), tips[7]);
  assert.equal(await jitoTipAccount({ fetch, random: () => 0, now: 2 }), tips[0]);
  assert.equal(calls, 1);
  assert.ok(JITO_TIP_LAMPORTS >= 1000n && JITO_TIP_LAMPORTS <= 5000000n);
  resetJitoCache();
  await assert.rejects(jitoTipAccount({ fetch: reply({ jsonrpc: "2.0", id: 1, result: tips.slice(0, 2) }), now: 3 }), (e) => e.safe);
  resetJitoCache();
  await assert.rejects(jitoTipAccount({ fetch: reply({ jsonrpc: "2.0", id: 1, result: [...tips.slice(0, 7), tips[0]] }), now: 4 }), (e) => e.safe);
});

test("sendBundle posts base64 encoding and returns the bundle id", async () => {
  let sent;
  const fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return reply({ jsonrpc: "2.0", id: 1, result: "a".repeat(64) })();
  };
  assert.equal(await sendJitoBundle(["AAA", "BBB"], { fetch }), "a".repeat(64));
  assert.match(sent.url, /\/api\/v1\/bundles$/);
  assert.equal(sent.body.method, "sendBundle");
  assert.deepEqual(sent.body.params, [["AAA", "BBB"], { encoding: "base64" }]);
});

test("rate limits and network errors are retryable; rejections are not", async () => {
  await assert.rejects(sendJitoBundle(["A"], { fetch: reply({ error: "x" }, 429) }), (e) => e.safe && e.retryable === true);
  await assert.rejects(sendJitoBundle(["A"], { fetch: async () => { throw new TypeError("fetch failed https://x?api-key=k"); } }),
    (e) => e.retryable === true && !/api-key=k/.test(e.detail));
  await assert.rejects(sendJitoBundle(["A"], { fetch: reply({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bundle contains an already processed transaction" } }) }),
    (e) => e.safe && e.retryable === false && /already processed/.test(e.detail));
  await assert.rejects(sendJitoBundle([], {}), (e) => e.safe && e.retryable === false);
  await assert.rejects(sendJitoBundle(["1", "2", "3", "4", "5", "6"], {}), (e) => e.retryable === false);
});

test("in-flight status maps Jito states", async () => {
  const id = "b".repeat(64);
  const status = (s, slot = null) => reply({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [{ bundle_id: id, status: s, landed_slot: slot }] } });
  assert.deepEqual(await jitoBundleStatus(id, { fetch: status("Landed", 42) }), { state: "landed", slot: 42 });
  assert.deepEqual(await jitoBundleStatus(id, { fetch: status("Pending") }), { state: "pending" });
  assert.deepEqual(await jitoBundleStatus(id, { fetch: status("Invalid") }), { state: "invalid" });
  assert.deepEqual(await jitoBundleStatus(id, { fetch: reply({ jsonrpc: "2.0", id: 1, result: { value: [] } }) }), { state: "unknown" });
});
