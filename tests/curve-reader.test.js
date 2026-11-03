import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { pump } from "../lib/pump-adapter.mjs";
import { NEAR, GENESIS } from "../lib/solana-rpc.mjs";
import { curveReader } from "../lib/curve-reader.mjs";
const mint = NEAR;
// Test-only encoded account bytes, decoded by the real official SDK.
function account(quote = NEAR) {
  const data = Buffer.alloc(166);
  data.set(
    pump.pumpIdl.accounts.find((a) => a.name === "BondingCurve").discriminator,
  );
  for (const [offset, n] of [
    [8, 1073000000000000n],
    [16, 3000000000000n],
    [24, 793100000000000n],
    [32, 0n],
    [40, 1000000000000000n],
  ])
    data.writeBigUInt64LE(n, offset);
  new PublicKey(quote).toBuffer().copy(data, 83);
  return { data, owner: pump.PUMP_PROGRAM_ID };
}
test("curve reads verify finalized chain/account/quote identity and coalesce cached reads", async () => {
  let calls = 0,
    now = 0;
  const reader = curveReader({
    clock: () => now,
    rpc: () => ({
      getGenesisHash: async () => GENESIS.mainnet,
      getAccountInfoAndContext: async (address, options) => {
        calls++;
        assert.equal(options.commitment, "finalized");
        assert.ok(address.equals(pump.bondingCurvePda(new PublicKey(mint))));
        return { context: { slot: 42 }, value: account() };
      },
    }),
  });
  const [a, b] = await Promise.all([reader(mint), reader(mint)]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.equal(a.progressBps, 0);
  assert.equal(a.slot, 42);
  assert.equal(a.quoteMint, NEAR);
  now = 16000;
  await reader(mint);
  assert.equal(calls, 2);
});
test("unverified networks, programs, quote mints and supplies never produce curve metrics", async () => {
  for (const fault of ["network", "program", "quote", "supply", "slot"]) {
    const value = account(
      fault === "quote" ? pump.PUMP_PROGRAM_ID.toBase58() : NEAR,
    );
    if (fault === "program") value.owner = new PublicKey(NEAR);
    if (fault === "supply") value.data.writeBigUInt64LE(1n, 40);
    const reader = curveReader({
      rpc: () => ({
        getGenesisHash: async () =>
          fault === "network" ? "wrong" : GENESIS.mainnet,
        getAccountInfoAndContext: async () => ({
          context: { slot: fault === "slot" ? null : 42 },
          value,
        }),
      }),
    });
    await assert.rejects(reader(mint));
  }
});
test("failed curve reads recover after a short negative-cache interval", async () => {
  let calls = 0,
    now = 0;
  const reader = curveReader({
    clock: () => now,
    rpc: () => ({
      getGenesisHash: async () => GENESIS.mainnet,
      getAccountInfoAndContext: async () => {
        calls++;
        if (calls === 1) throw Error("RPC unavailable");
        return { context: { slot: 43 }, value: account() };
      },
    }),
  });
  await assert.rejects(reader(mint));
  await assert.rejects(reader(mint));
  assert.equal(calls, 1);
  now = 5001;
  const recovered = await reader(mint);
  assert.equal(calls, 2);
  assert.equal(recovered.slot, 43);
});
