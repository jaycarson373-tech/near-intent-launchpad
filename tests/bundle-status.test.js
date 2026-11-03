import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { bundleStatus, legacyBundleStatus, verifyBuyReceipt, RESEND_MS } from "../server/pump-launch.js";
import { compileBundleTx } from "../lib/launch-bundle.mjs";
import { compileLaunchV1 } from "../lib/launch-wire.mjs";
import { NEAR } from "../lib/solana-rpc.mjs";

const creator = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
const row = (err = null, confirmationStatus = "finalized") => ({ slot: 1, confirmations: null, err, confirmationStatus });
function launch(extra = {}) {
  const id = randomUUID();
  return {
    d: { id, bundle: true, mint: mint.toBase58(), creator: creator.toBase58(), lastValidBlockHeight: 100, estimatedSolRaw: "50000000", instructionCounts: [3, 3, 3], traces: [20, 40, 30], ...extra },
    saved: { id, bundle: true, signature: "sigB", signatures: ["sigA", "sigB", "sigC"], roles: ["setup", "create", "fees"], wires: ["QQ==", "Qg==", "Qw=="], createdAt: 1 },
  };
}
function harness({ rows = [null, null, null], height = 50, context = 10, records = {}, send, rpc = {}, simulate } = {}) {
  const m = new Map(Object.entries(records)), sent = [], removed = [];
  const io = {
    read: async (k) => m.get(k) ?? null,
    create: async (k, v) => {
      if (m.has(k)) throw Error("exists");
      m.set(k, v);
    },
    createOnce: async (k, v, same) => {
      if (!m.has(k)) {
        m.set(k, v);
        return v;
      }
      if (same(m.get(k), v)) return m.get(k);
      throw Error("exists");
    },
    removePointer: async (k) => removed.push(k),
    sendJitoBundle: send || (async (wires) => (sent.push(wires), "ab".repeat(32))),
    simulateLaunchBundle: simulate || (async () => assert.fail("no bundle simulation expected")),
    rpc: { getSlot: async () => 10, getBlockHeight: async () => height, getSignatureStatuses: async () => ({ context: { slot: context }, value: rows }), ...rpc },
  };
  return { io, m, sent, removed };
}
const at = (io, now) => ({ ...io, now: () => now });

test("an unseen bundle is resent with identical bytes at most once per window per draft", async () => {
  const { d, saved } = launch(), h = harness({ records: { ["broadcasts/" + d.id + ".json"]: { id: d.id, signature: "sigB" } } });
  for (const now of [10000, 10500, 11900]) assert.equal((await bundleStatus(d, saved, false, at(h.io, now))).status, "submitted");
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], saved.wires);
  assert.equal((await bundleStatus(d, saved, false, at(h.io, 10000 + RESEND_MS + 100))).status, "submitted");
  assert.equal(h.sent.length, 2);
});
test("another instance's recent send blocks a resend even without local memory", async () => {
  const { d, saved } = launch(), now = 20500, bucket = Math.floor(now / RESEND_MS);
  const h = harness({ records: { ["broadcasts/" + d.id + ".json"]: { id: d.id, signature: "sigB" }, ["jito/" + d.id + "-" + (bucket - 1) + ".json"]: { claimedAt: now - 600 } } });
  assert.equal((await bundleStatus(d, saved, false, at(h.io, now))).status, "submitted");
  assert.equal(h.sent.length, 0);
});
test("a Jito rate limit is not a failure: the launch stays submitted for a later identical resend", async () => {
  const { d, saved } = launch();
  const h = harness({ records: { ["broadcasts/" + d.id + ".json"]: { id: d.id, signature: "sigB" } }, send: async () => { throw Object.assign(Error("Jito is busy."), { safe: true, status: 503, retryable: true }); } });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await bundleStatus(d, saved, false, at(h.io, 30000))).status, "submitted");
  } finally {
    console.error = original;
  }
});
test("nothing seen after lastValidBlockHeight is expired and never resent", async () => {
  const { d, saved } = launch(), h = harness({ height: 101, records: { ["broadcasts/" + d.id + ".json"]: { id: d.id } } });
  const r = await bundleStatus(d, saved, false, at(h.io, 40000));
  assert.equal(r.status, "expired");
  assert.equal(h.sent.length, 0);
  assert.equal(h.removed.length, 1);
});
test("a lagging status node or an unsent review never triggers a send", async () => {
  const { d, saved } = launch();
  const lag = harness({ context: 9, records: { ["broadcasts/" + d.id + ".json"]: { id: d.id } } });
  assert.equal((await bundleStatus(d, saved, false, at(lag.io, 50000))).status, "checking");
  const unsent = harness();
  assert.equal((await bundleStatus(d, saved, false, at(unsent.io, 50000))).status, "checking");
  const blocked = harness({ records: { ["submission-checks/" + d.id + ".json"]: { signature: "sigB", error: "blocked reason" } } });
  assert.deepEqual(await bundleStatus(d, saved, false, at(blocked.io, 50000)), { status: "blocked", signature: "sigB", mint: d.mint, error: "blocked reason" });
  assert.equal(lag.sent.length + unsent.sent.length + blocked.sent.length, 0);
});
test("a partly landed bundle is recorded once settled and never re-signed or resent", async () => {
  const { d, saved } = launch();
  const pending = harness({ rows: [row(), row(), null], height: 99 });
  assert.equal((await bundleStatus(d, saved, true, at(pending.io, 60000))).status, "confirming");
  assert.equal(pending.sent.length, 0);
  const settled = harness({ rows: [row(), row(), null], height: 101 });
  const r = await bundleStatus(d, saved, true, at(settled.io, 60000));
  assert.equal(r.status, "partial");
  assert.equal(r.created, true);
  assert.equal(r.feesLanded, false);
  assert.match(r.error, /without its fee setup/);
  assert.ok(![...settled.m.keys()].some((k) => k.startsWith("receipts/")), "a coin without fees is never published");
  assert.deepEqual(settled.m.get("partials/" + d.id + ".json").states, ["landed", "landed", "missing"]);
  settled.io.rpc.getSignatureStatuses = async () => assert.fail("a recorded outcome is final");
  assert.equal((await bundleStatus(d, saved, true, at(settled.io, 61000))).status, "partial");
  const noCoin = harness({ rows: [row(), null, null], height: 101 });
  const n = await bundleStatus(d, saved, false, at(noCoin.io, 60000));
  assert.equal(n.status, "partial");
  assert.equal(n.created, false);
  const buyFailed = harness({ rows: [row(), row(), row({ InstructionError: [2, "Custom"] })], height: 60 });
  assert.equal((await bundleStatus(d, saved, false, at(buyFailed.io, 60000))).created, true);
  assert.equal(pending.sent.length + settled.sent.length + noCoin.sent.length + buyFailed.sent.length, 0);
});
test("a finalized creation error is failed; an unfinalized one keeps confirming", async () => {
  const { d, saved } = launch();
  const failed = harness({ rows: [null, row({ InstructionError: [2, "Custom"] }), null] });
  assert.equal((await bundleStatus(d, saved, false, at(failed.io, 70000))).status, "failed");
  const early = harness({ rows: [null, row({ InstructionError: [2, "Custom"] }, "confirmed"), null] });
  assert.equal((await bundleStatus(d, saved, false, at(early.io, 70000))).status, "confirming");
});
test("first submission simulates the exact signed bundle before any send", async () => {
  const payer = creator, blockhash = Keypair.generate().publicKey.toBase58();
  const tx = (n) => compileBundleTx({ payer, blockhash, computeUnitLimit: 200000, instructions: Array.from({ length: n }, () => SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 })) });
  const wires = [tx(1), tx(1), tx(1)].map((t) => Buffer.from(t.serialize()).toString("base64"));
  const { d, saved } = launch({ instructionCounts: [3, 3, 3], traces: [20, 40, 30], simulationAddresses: [creator.toBase58()] });
  saved.wires = wires;
  const calls = [];
  const sim = (after, logs = []) => async (rpc, w, addresses, options) => {
    calls.push({ w, addresses, options });
    return { slot: 12, before: [{ lamports: 100000000 }], after: [{ lamports: after }], results: w.map(() => ({ err: null, logs, fee: 5000 })) };
  };
  const base = { getFeeForMessage: async () => ({ value: 5000 }) };
  const fee = harness({ rpc: { ...base, getFeeForMessage: async () => ({ value: 600000 }) } });
  assert.match((await bundleStatus(d, saved, true, at(fee.io, 80000))).error, /network fee/);
  const budget = harness({ rpc: base, simulate: sim(100000000 - 60000000) });
  assert.match((await bundleStatus(d, saved, true, at(budget.io, 80000))).error, /SOL budget/);
  const failing = harness({ rpc: base, simulate: async () => { throw Object.assign(Error("The complete launch bundle exceeds Solana’s instruction limit."), { safe: true, status: 503 }); } });
  assert.match((await bundleStatus(d, saved, true, at(failing.io, 80000))).error, /instruction limit/);
  const rejected = harness({ rpc: base, simulate: async () => { throw Object.assign(Error("did not pass simulation"), { safe: true, status: 503 }); } });
  assert.match((await bundleStatus(d, saved, true, at(rejected.io, 80000))).error, /no longer passes simulation/);
  const deep = harness({ rpc: base, simulate: sim(99000000, Array.from({ length: 65 }, () => "Program 11111111111111111111111111111111 invoke [1]")) });
  assert.match((await bundleStatus(d, saved, true, at(deep.io, 80000))).error, /instruction limit/);
  const incomplete = harness({ rpc: base, simulate: sim(99000000) });
  assert.match((await bundleStatus({ ...d, simulationAddresses: undefined }, saved, true, at(incomplete.io, 80000))).error, /incomplete/);
  assert.equal(fee.sent.length + budget.sent.length + failing.sent.length + rejected.sent.length + deep.sent.length + incomplete.sent.length, 0);
  assert.ok(budget.m.has("submission-checks/" + d.id + ".json"));
  const ok = harness({ rpc: base, simulate: sim(99000000) });
  calls.length = 0;
  const r = await bundleStatus(d, saved, true, at(ok.io, 80000));
  assert.equal(r.status, "submitted");
  assert.deepEqual(calls[0].w, wires, "the exact signed wires are simulated");
  assert.equal(calls[0].options.signed, true);
  assert.deepEqual(ok.sent, [wires]);
  assert.ok(ok.m.has("broadcasts/" + d.id + ".json"));
});
test("too many wallet-added instructions block submission when the trace would exceed 64", async () => {
  const payer = creator, blockhash = Keypair.generate().publicKey.toBase58();
  const tx = (n) => compileBundleTx({ payer, blockhash, computeUnitLimit: 200000, instructions: Array.from({ length: n }, () => SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 })) });
  const { d, saved } = launch({ instructionCounts: [3, 3, 3], traces: [20, 60, 30] });
  saved.wires = [tx(1), tx(6), tx(1)].map((t) => Buffer.from(t.serialize()).toString("base64"));
  const h = harness({ rpc: { getFeeForMessage: async () => ({ value: 5000 }) } });
  assert.match((await bundleStatus(d, saved, true, at(h.io, 90000))).error, /instruction limit/);
  assert.equal(h.sent.length, 0);
});

const keys = [creator, getAssociatedTokenAddressSync(new PublicKey(NEAR), creator), getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID), Keypair.generate().publicKey];
const balance = (index, asset, amount, programId = TOKEN_PROGRAM_ID) => ({ accountIndex: index, mint: asset, owner: creator.toBase58(), programId: programId.toBase58(), uiTokenAmount: { amount } });
const receipt = (pre, post) => ({ transaction: { message: { getAccountKeys: () => ({ get: (i) => keys[i] }) } }, meta: { loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: pre, postTokenBalances: post } });
test("the bundle buy receipt spends at most the reviewed NEAR and credits the new mint to the creator", () => {
  const d = { creator: creator.toBase58(), mint: mint.toBase58(), devBuyRaw: "1000" };
  const ok = receipt([balance(1, NEAR, "5000")], [balance(1, NEAR, "4000"), balance(2, mint.toBase58(), "777", TOKEN_2022_PROGRAM_ID)]);
  assert.equal(verifyBuyReceipt(ok, d), "777");
  assert.throws(() => verifyBuyReceipt(receipt([balance(1, NEAR, "5000")], [balance(1, NEAR, "3999"), balance(2, mint.toBase58(), "777", TOKEN_2022_PROGRAM_ID)]), d), /more NEAR/);
  assert.throws(() => verifyBuyReceipt(receipt([balance(1, NEAR, "5000")], [balance(1, NEAR, "4000")]), d), /did not credit/);
  assert.throws(() => verifyBuyReceipt(receipt([balance(3, NEAR, "10")], [balance(3, NEAR, "9"), balance(2, mint.toBase58(), "777", TOKEN_2022_PROGRAM_ID)]), d), /another wallet token/);
});

test("a v1 wire in a saved bundle is never simulated or sent", async () => {
  const payer = creator, blockhash = Keypair.generate().publicKey.toBase58(), transfer = () => SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const v0 = Buffer.from(compileBundleTx({ payer, blockhash, computeUnitLimit: 200000, instructions: [transfer()] }).serialize()).toString("base64");
  const v1 = Buffer.from(compileLaunchV1({ payer, latest: { blockhash, lastValidBlockHeight: 100 }, instructions: [transfer()] }).serialize()).toString("base64");
  const { d, saved } = launch({ simulationAddresses: [creator.toBase58()] });
  saved.wires = [v0, v1, v0];
  const h = harness({ rpc: { getFeeForMessage: async () => ({ value: 5000 }) } });
  const r = await bundleStatus(d, saved, true, at(h.io, 95000));
  assert.equal(r.status, "blocked");
  assert.match(r.error, /not a v0 bundle/);
  assert.equal(h.sent.length, 0);
});
test("v1 bundles saved before the v0 fix are reconciled from chain state only and never resent", async () => {
  const { d, saved } = launch();
  const legacy = { ...d, wires: saved.wires, creationIndex: 1, tradeIndex: 2 };
  delete legacy.roles;
  const accountInfo = (exists) => async () => (exists ? { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(0) } : null);
  const live = harness({ height: 99, rpc: { getAccountInfo: accountInfo(false) } });
  assert.equal((await legacyBundleStatus(legacy, saved, live.io)).status, "checking");
  const expired = harness({ height: 101, rpc: { getAccountInfo: accountInfo(false) } });
  assert.equal((await legacyBundleStatus(legacy, saved, expired.io)).status, "review");
  assert.equal(expired.removed.length, 1);
  const minted = harness({ height: 101, rpc: { getAccountInfo: accountInfo(true) } });
  assert.equal((await legacyBundleStatus(legacy, saved, minted.io)).status, "reconciling");
  const partly = harness({ rows: [row(), null, null], height: 101, rpc: { getAccountInfo: accountInfo(false) } });
  assert.equal((await legacyBundleStatus(legacy, saved, partly.io)).status, "reconciling");
  assert.equal(live.sent.length + expired.sent.length + minted.sent.length + partly.sent.length, 0);
});
