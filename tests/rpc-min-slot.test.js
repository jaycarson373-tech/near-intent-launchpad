import test from "node:test";
import assert from "node:assert/strict";
import { Connection } from "@solana/web3.js";
import { rpcFetch } from "../lib/solana-rpc.mjs";

const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const behind = { jsonrpc: "2.0", id: 1, error: { code: -32016, message: "Minimum context slot has not been reached", data: { contextSlot: 1 } } };

test("a lagging load-balanced node is retried, then the real answer reaches web3.js", async () => {
  let calls = 0;
  const base = async (_u, init) => {
    const id = JSON.parse(init.body).id;
    return ++calls < 3 ? reply({ ...behind, id }) : reply({ jsonrpc: "2.0", id, result: 424242 });
  };
  const conn = new Connection("https://rpc.invalid", { fetch: (i, init) => rpcFetch(i, init, { base, delayMs: 1 }) });
  assert.equal(await conn.getSlot(), 424242);
  assert.equal(calls, 3);
});

test("other errors are not retried, and retries stop at the attempt limit", async () => {
  let calls = 0;
  const other = async () => (calls++, reply({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed" } }));
  await rpcFetch("https://rpc.invalid", { method: "POST", body: "{}" }, { base: other, delayMs: 1 });
  assert.equal(calls, 1);
  calls = 0;
  const always = async () => (calls++, reply(behind));
  const r = await rpcFetch("https://rpc.invalid", { method: "POST", body: "{}" }, { base: always, attempts: 4, delayMs: 1 });
  assert.equal(calls, 4);
  assert.match(await r.text(), /-32016/);
});
