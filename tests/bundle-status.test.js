import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { bundleStatus, verifyBuyReceipt, RESEND_MS } from "../server/pump-launch.js";
import { compileBundleTx } from "../lib/launch-bundle.mjs";
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
function harness({ rows = [null, null, null], height = 50, context = 10, records = {}, send, rpc = {} } = {}) {
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
test("first submission runs signed preflight checks before any send", async () => {
  const payer = creator, blockhash = Keypair.generate().publicKey.toBase58();
  const tx = (n) => compileBundleTx({ payer, blockhash, computeUnitLimit: 200000, instructions: Array.from({ length: n }, () => SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 })) });
  const wires = [tx(1), tx(1), tx(1)].map((t) => Buffer.from(t.serialize()).toString("base64"));
  const { d, saved } = launch({ instructionCounts: [3, 3, 3], traces: [20, 40, 30] });
  saved.wires = wires;
  const sim = (lamports, err = null) => async () => ({ context: { slot: 12 }, value: { err, accounts: [{ lamports }], logs: [] } });
  const base = { getFeeForMessage: async () => ({ value: 5000 }), getBalanceAndContext: async () => ({ context: { slot: 11 }, value: 100000000 }) };
  const fee = harness({ rpc: { ...base, getFeeForMessage: async () => ({ value: 600000 }) } });
  assert.match((await bundleStatus(d, saved, true, at(fee.io, 80000))).error, /network fee/);
  const budget = harness({ rpc: { ...base, simulateTransaction: sim(100000000 - 60000000) } });
  assert.match((await bundleStatus(d, saved, true, at(budget.io, 80000))).error, /SOL budget/);
  const original = console.error;
  console.error = () => {};
  const failing = harness({ rpc: { ...base, simulateTransaction: sim(99000000, { InstructionError: [0, "MaxInstructionTraceLengthExceeded"] }) } });
  try {
    assert.match((await bundleStatus(d, saved, true, at(failing.io, 80000))).error, /instruction limit/);
  } finally {
    console.error = original;
  }
  assert.equal(fee.sent.length + budget.sent.length + failing.sent.length, 0);
  assert.ok(budget.m.has("submission-checks/" + d.id + ".json"));
  const ok = harness({ rpc: { ...base, simulateTransaction: sim(99000000) } });
  const r = await bundleStatus(d, saved, true, at(ok.io, 80000));
  assert.equal(r.status, "submitted");
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
