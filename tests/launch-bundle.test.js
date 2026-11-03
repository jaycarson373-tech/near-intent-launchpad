import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  AddressLookupTableAccount,
  AddressLookupTableProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { getTransactionDecoder, getTransactionEncoder } from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { launchParts, buyInstructions, buildBundle, launchMemo, bundleBytes, assertBuyInstructions, minimumTokensOut, MAX_TRANSACTION_BYTES, WALLET_BYTE_ALLOWANCE, MEMO_PROGRAM } from "../lib/launch-bundle.mjs";
import { fixedLaunchAccounts, launchLookupTable, lookupTableDigest, resetLookupTableCache } from "../lib/lookup-table.mjs";
import { walletSignedLaunchMatches } from "../lib/launch-signatures.mjs";
import { NEAR, SOL } from "../lib/solana-rpc.mjs";

const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const LIGHTHOUSE = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
const treasury = Keypair.generate().publicKey.toBase58();
const c = {
  quote: { mint: NEAR, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), creatorFeeBps: 30 },
  global: { buybackFeeRecipients: [PublicKey.default, Keypair.generate().publicKey] },
};
const pools = Array.from({ length: 12 }, () => Keypair.generate().publicKey);
const tableOf = (addresses, key = Keypair.generate().publicKey) =>
  new AddressLookupTableAccount({
    key,
    state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: addresses.map((a) => new PublicKey(a)) },
  });
// A Jupiter-shaped single-hop conversion: wrap exactly, swap through pool accounts, unwrap.
function conversion(creator) {
  const wsol = getAssociatedTokenAddressSync(new PublicKey(SOL), creator), near = getAssociatedTokenAddressSync(new PublicKey(NEAR), creator);
  return [
    createAssociatedTokenAccountIdempotentInstruction(creator, wsol, creator, new PublicKey(SOL)),
    createAssociatedTokenAccountIdempotentInstruction(creator, near, creator, new PublicKey(NEAR)),
    SystemProgram.transfer({ fromPubkey: creator, toPubkey: wsol, lamports: 100000000 }),
    createSyncNativeInstruction(wsol),
    new TransactionInstruction({
      programId: JUP,
      keys: [creator, wsol, near, new PublicKey(SOL), new PublicKey(NEAR), TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, JUP, ...pools].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i < 3 || i > 8 })),
      data: Buffer.alloc(42, 7),
    }),
    createCloseAccountInstruction(wsol, creator, creator),
  ];
}
async function fixture({ devBuyRaw = 1000000000n, withConversion = true, tables, poolsInTable = true } = {}) {
  const creator = Keypair.generate(), mint = Keypair.generate(), tip = Keypair.generate().publicKey.toBase58();
  // Production-size metadata: 19-byte name, 8-byte symbol, 93-char URI.
  const input = { creator: creator.publicKey, mint: mint.publicKey, feeTreasury: treasury, name: "NEAR Community Coin", symbol: "NEARCOIN", uri: "https://near-intent-launchpad.vercel.app/api/metadata?id=" + randomUUID(), creatorFeeBps: 30, devBuyRaw: 0n };
  const parts = await launchParts(input, c);
  const made = new Set(parts.setup.map((ix) => ix.keys[1].pubkey.toBase58()));
  const buy = devBuyRaw > 0n ? (await buyInstructions({ creator: creator.publicKey, mint: mint.publicKey, devBuyRaw, amount: 3000000000000n, c })).filter((ix) => !ix.programId.equals(new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")) || !made.has(ix.keys[1].pubkey.toBase58())) : [];
  const fixed = await fixedLaunchAccounts(c, { treasury });
  const table = tableOf(poolsInTable ? [...fixed, ...pools.map(String), SOL] : fixed);
  const setup = withConversion ? [...conversion(creator.publicKey), ...parts.setup.filter((ix) => !ix.keys[1].pubkey.equals(getAssociatedTokenAddressSync(new PublicKey(NEAR), creator.publicKey)))] : parts.setup;
  const record = { mint: mint.publicKey.toBase58(), creator: creator.publicKey.toBase58(), creatorFeeBps: 30, feeTreasury: treasury, rewardPolicyHash: "a".repeat(64), devBuyRaw: String(devBuyRaw), devBuySolRaw: "100000000" };
  const args = { payer: creator.publicKey, mint: mint.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), tables: tables || [table], setup, create: parts.create, fees: parts.fees, buy, memo: launchMemo(randomUUID(), record), tip: { account: tip, lamports: 10000n }, conversion: withConversion };
  return { creator, mint, tip, table, args, fixed };
}
const sign = (tx, keys) => {
  const d = getTransactionDecoder().decode(tx.serialize()), signatures = { ...d.signatures };
  for (const k of keys) signatures[k.publicKey.toBase58()] = ed25519.sign(d.messageBytes, k.secretKey.slice(0, 32));
  return new Uint8Array(getTransactionEncoder().encode({ ...d, signatures }));
};
const sizeOf = bundleBytes;
const programs = (tx) => tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58());

// Measured 2026-11-02 (93-char URI, 22 fixed table entries): no buy 608/757/614 bytes, NEAR buy
// 608/757/873, SOL buy 882/757/873 with the route's 12 pool accounts in the table.
test("every production-size part leaves 200 bytes for the wallet: no buy, NEAR buy and SOL buy", async () => {
  assert.equal(WALLET_BYTE_ALLOWANCE, 200);
  for (const options of [{ devBuyRaw: 0n, withConversion: false }, { withConversion: false }, {}]) {
    const { args } = await fixture(options);
    for (const { role, tx } of buildBundle(args))
      assert.ok(sizeOf(tx) + WALLET_BYTE_ALLOWANCE <= MAX_TRANSACTION_BYTES, Object.keys(options).join() + " " + role + " is " + sizeOf(tx) + " bytes");
  }
});
test("a SOL buy whose route pools are not in the table fails closed before approval", async () => {
  const { args } = await fixture({ poolsInTable: false });
  assert.throws(() => buildBundle(args), /room for wallet security checks/);
});
test("bundle layout: memo in setup, createV2 + tip only in create, fee assignment + buy in fees", async () => {
  const { creator, mint, tip, args } = await fixture();
  const bundle = buildBundle(args), [setup, create, fees] = bundle.map((b) => b.tx);
  assert.deepEqual(bundle.map((b) => b.role), ["setup", "create", "fees"]);
  for (const { role, tx } of bundle) {
    const keys = tx.message.staticAccountKeys.map(String), signers = keys.slice(0, tx.message.header.numRequiredSignatures);
    assert.equal(tx.message.version, 0);
    assert.equal(tx.message.addressTableLookups.length, 1, role + " uses the lookup table");
    assert.equal(keys.includes(tip), role === "create");
    assert.deepEqual(signers, role === "create" ? [creator.publicKey.toBase58(), mint.publicKey.toBase58()] : [creator.publicKey.toBase58()]);
    assert.equal(tx.message.recentBlockhash, args.blockhash);
  }
  const budget = "ComputeBudget111111111111111111111111111111", pumpProgram = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", pfee = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
  assert.deepEqual(programs(create), [pumpProgram, SystemProgram.programId.toBase58()]);
  const last = create.message.compiledInstructions.at(-1);
  assert.equal(create.message.staticAccountKeys[last.accountKeyIndexes[1]].toBase58(), tip);
  assert.equal(programs(setup).slice(0, 2).join(), [budget, budget].join());
  assert.equal(programs(setup).at(-1), MEMO_PROGRAM.toBase58());
  assert.equal(programs(setup).filter((p) => p === MEMO_PROGRAM.toBase58()).length, 1);
  assert.deepEqual(programs(fees).slice(0, 4), [budget, budget, pfee, pfee]);
  assert.equal(programs(fees).at(-1), pumpProgram);
  assert.ok(!programs(fees).includes(MEMO_PROGRAM.toBase58()) && !programs(create).includes(MEMO_PROGRAM.toBase58()));
});
test("no initial buy: the fees transaction still carries the full fee assignment and nothing else", async () => {
  const { args } = await fixture({ devBuyRaw: 0n, withConversion: false });
  const bundle = buildBundle(args);
  assert.deepEqual(bundle.map((b) => b.role), ["setup", "create", "fees"]);
  assert.deepEqual(programs(bundle[2].tx), ["ComputeBudget111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"]);
});
test("a missing lookup table, or one holding the tip account or a signer, fails before approval", async () => {
  const { args } = await fixture({ tables: [] });
  assert.throws(() => buildBundle(args), /room for wallet security checks/);
  const withTip = await fixture();
  assert.throws(() => buildBundle({ ...withTip.args, tables: [tableOf([...withTip.fixed, withTip.tip])] }), /signer or tip/);
  assert.throws(() => buildBundle({ ...withTip.args, tables: [tableOf([...withTip.fixed, withTip.mint.publicKey])] }), /signer or tip/);
});
test("fixed lookup accounts exclude every creator, mint and signer derived address", async () => {
  const fixed = await fixedLaunchAccounts(c, { treasury });
  const { creator, mint } = await fixture();
  for (const k of [creator.publicKey, mint.publicKey, getAssociatedTokenAddressSync(new PublicKey(NEAR), creator.publicKey), getAssociatedTokenAddressSync(mint.publicKey, creator.publicKey, true, TOKEN_2022_PROGRAM_ID)])
    assert.ok(!fixed.includes(k.toBase58()));
  for (const k of [NEAR, treasury, getAssociatedTokenAddressSync(new PublicKey(NEAR), new PublicKey(treasury)).toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]) assert.ok(fixed.includes(k), k);
  assert.deepEqual(fixed, [...fixed].sort());
  await assert.rejects(fixedLaunchAccounts(c, { treasury: null }), /INTENT_TREASURY_ADDRESS/);
});
test("lookup derivation aborts when no conversion route can be sampled, rather than guessing pools", async () => {
  const transport = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(fixedLaunchAccounts(c, { treasury, includeConversionPools: true, transport }), /No SOL conversion route/);
});
test("the buy is built exactly: amount, slippage floor, creator accounts", async () => {
  const creator = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, amount = 3000000000000n;
  const ixs = await buyInstructions({ creator, mint, devBuyRaw: 5n, amount, c });
  const args = { creator, mint, devBuyRaw: 5n, minTokensOut: minimumTokensOut(amount), quoteTokenProgram: TOKEN_PROGRAM_ID };
  assert.doesNotThrow(() => assertBuyInstructions(ixs, args));
  assert.equal(minimumTokensOut(amount), 2970000000000n);
  for (const bad of [{ devBuyRaw: 6n }, { minTokensOut: 1n }, { creator: Keypair.generate().publicKey }, { mint: Keypair.generate().publicKey }])
    assert.throws(() => assertBuyInstructions(ixs, { ...args, ...bad }), /initial buy differs/);
});

// Wallet edits: the same reviewed table and indexes are accepted; anything else is refused.
async function walletCase() {
  const { creator, mint, args } = await fixture();
  const bundle = buildBundle(args), table = args.tables[0], ixs = [...args.fees, ...args.buy];
  const recompile = ({ instructions = ixs, tables = [table], blockhash = args.blockhash, units = 700000, extra = [] } = {}) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...instructions, ...extra] }).compileToV0Message(tables));
  const light = Array.from({ length: 3 }, () => new TransactionInstruction({ programId: LIGHTHOUSE, keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) }));
  return { buy: bundle[2].tx, create: bundle[1].tx, table, recompile, light, creator, mint, ixs };
}
test("signed bundle parts may add Lighthouse checks and retune compute with the reviewed lookups", async () => {
  const { buy, create, recompile, light, creator, mint } = await walletCase();
  walletSignedLaunchMatches(buy.serialize(), sign(buy, [creator]));
  const edited = recompile({ units: 900000, extra: light });
  assert.ok(edited.message.addressTableLookups.length === 1);
  walletSignedLaunchMatches(buy.serialize(), sign(edited, [creator]));
  walletSignedLaunchMatches(create.serialize(), sign(create, [creator, mint]));
  assert.throws(() => walletSignedLaunchMatches(create.serialize(), sign(create, [creator])), /incomplete|invalid/);
});
test("signed bundle parts cannot add a table, move an index, reorder or drop instructions, or change blockhash", async () => {
  const { buy, table, recompile, creator, ixs } = await walletCase();
  assert.ok(ixs.length >= 2);
  const other = tableOf([Keypair.generate().publicKey, ...table.state.addresses]);
  const shuffled = tableOf([...table.state.addresses].reverse(), table.key);
  const extraTable = tableOf([Keypair.generate().publicKey, Keypair.generate().publicKey]);
  const viaExtra = new TransactionInstruction({ programId: LIGHTHOUSE, keys: [{ pubkey: extraTable.state.addresses[1], isSigner: false, isWritable: false }], data: Buffer.from([1]) });
  for (const [label, tx] of [
    ["new table", recompile({ tables: [other] })],
    ["changed index", recompile({ tables: [shuffled] })],
    ["added table", recompile({ tables: [table, extraTable], extra: [viaExtra] })],
    ["reordered", recompile({ instructions: [ixs[1], ixs[0], ...ixs.slice(2)] })],
    ["removed", recompile({ instructions: ixs.slice(1) })],
    ["blockhash", recompile({ blockhash: Keypair.generate().publicKey.toBase58() })],
  ])
    assert.throws(() => walletSignedLaunchMatches(buy.serialize(), sign(tx, [creator])), /altered|lookup/, label);
});

// Frozen lookup table loader.
function tableAccount(addresses, { authority = null, deactivation = 2n ** 64n - 1n, owner = AddressLookupTableProgram.programId } = {}) {
  const data = Buffer.alloc(56 + 32 * addresses.length);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(deactivation, 4);
  if (authority) {
    data[21] = 1;
    authority.toBuffer().copy(data, 22);
  }
  addresses.forEach((a, i) => new PublicKey(a).toBuffer().copy(data, 56 + 32 * i));
  return { owner, data, lamports: 1, executable: false };
}
test("the lookup table is used only when frozen, never deactivating and exactly the reviewed list", async () => {
  const addresses = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()], key = Keypair.generate().publicKey.toBase58();
  const env = { INTENT_LOOKUP_TABLE: key, INTENT_LOOKUP_TABLE_SHA256: lookupTableDigest([...addresses].reverse()) };
  const rpc = (account) => ({ getAccountInfo: async () => account });
  resetLookupTableCache();
  const table = await launchLookupTable(rpc(tableAccount(addresses)), { env });
  assert.equal(table.key.toBase58(), key);
  assert.deepEqual(table.state.addresses.map(String), addresses);
  for (const [label, account, e] of [
    ["authority", tableAccount(addresses, { authority: Keypair.generate().publicKey }), env],
    ["deactivating", tableAccount(addresses, { deactivation: 5n }), env],
    ["changed list", tableAccount([...addresses, Keypair.generate().publicKey.toBase58()]), env],
    ["foreign owner", tableAccount(addresses, { owner: SystemProgram.programId }), env],
    ["missing", null, env],
    ["unconfigured", tableAccount(addresses), { INTENT_LOOKUP_TABLE: key }],
  ]) {
    resetLookupTableCache();
    await assert.rejects(launchLookupTable(rpc(account), { env: e }), (error) => error.status === 503 && /table/.test(error.message), label);
  }
  resetLookupTableCache();
});
test("lookup digest is the de-duplicated, default-sorted, newline-joined list", () => {
  assert.equal(lookupTableDigest(["b", "a", "b"]), createHash("sha256").update("a\nb").digest("hex"));
  assert.notEqual(lookupTableDigest(["a", "b"]), lookupTableDigest(["a", "b", "c"]));
});
