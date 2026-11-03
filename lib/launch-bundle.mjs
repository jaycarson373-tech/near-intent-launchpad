// Jito bundle launch (layout v2): v0 transactions sharing one blockhash, fee payer and frozen lookup table.
// setup  = compute budget + idempotent quote ATA setup + INTENTPAD memo (+ the bounded SOL conversion)
// create = Pump createV2 + Jito tip, no compute budget (the mint signs only this one)
// fees   = compute budget + immutable 100% fee assignment (+ new-mint ATA and exact-quote buy if buying)
// A bundle lands in order inside one slot or not at all, and nothing can interleave between its
// transactions, so fee assignment stays atomic with creation. A create that lands outside its
// bundle without fees is detected as "partial" and never published.
import { createHash } from "node:crypto";
import BN from "bn.js";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { pump, launchInstructions } from "./pump-adapter.mjs";
import { NEAR } from "./solana-rpc.mjs";
import { fail } from "./http.js";
export const MAX_TRANSACTION_BYTES = 1232;
// Phantom-class wallets append Lighthouse assertions and may retune compute budget after review.
// Root decision 2026-11-02: 200 bytes per part until a real wallet capture measures it.
export const WALLET_BYTE_ALLOWANCE = 200;
export const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1000;
// create has no compute-budget instructions: default 200k CU per non-budget instruction.
export const BUNDLE_COMPUTE_UNITS = { setup: 200000, conversion: 1000000, fees: 700000 };
// Measured instruction-trace entries (top level + CPIs) for parts that cannot be simulated before
// their mint exists: idempotent new-mint ATA create = 5, buy_exact_quote_in_v3 = 6 (47 -> 58).
export const ATA_CREATE_TRACE = 5, BUY_TRACE = 6;
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const BUY_EXACT_QUOTE_IN_V3 = Buffer.from([225, 247, 80, 30, 213, 179, 132, 136]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isAta = (ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID);
// Pump SDK lessSlippage(amount, 1%, floor 1): the bound the single-transaction launch used.
export const minimumTokensOut = (amount) => {
  const a = BigInt(amount.toString()), out = a - (a * 10n) / 1000n;
  return out < 1n ? 1n : out;
};
export function buyQuote(input, c) {
  const curve = {
    ...pump.newBondingCurve(c.global, new PublicKey(NEAR), c.quoteControl, new BN(input.creatorFeeBps)),
    creator: pump.feeSharingConfigPda(input.mint),
    isMayhemMode: false,
  };
  const amount = pump.getBuyV3TokenAmountFromQuoteAmount({
    global: c.global,
    feeConfig: c.feeConfig,
    mintSupply: c.global.tokenTotalSupply,
    bondingCurve: curve,
    curveBaseTokenBalance: c.global.tokenTotalSupply,
    amount: new BN(input.devBuyRaw.toString()),
  });
  if (amount.lten(0) || amount.gte(curve.realTokenReserves))
    fail("The initial buy is too small or would graduate the market.");
  return { curve, amount };
}
export async function buyInstructions({ creator, mint, devBuyRaw, amount, curve, c }) {
  const minTokensOut = minimumTokensOut(amount),
    quoteTokenProgram = new PublicKey(c.quote.tokenProgram);
  const ixs = await pump.PUMP_SDK.buyExactQuoteInV3Instructions({
    mint,
    user: creator,
    bondingCurve: curve || { quoteMint: new PublicKey(NEAR), isCashbackCoin: false },
    associatedUserAccountInfo: null,
    quoteAmount: new BN(devBuyRaw.toString()),
    amount: new BN(amount.toString()),
    slippage: 1,
    partialFill: false,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram,
    buybackFeeRecipient: c.global.buybackFeeRecipients.find((k) => !k.equals(PublicKey.default)),
  });
  assertBuyInstructions(ixs, { creator, mint, devBuyRaw, minTokensOut, quoteTokenProgram });
  return ixs;
}
// The buy cannot be simulated before its mint exists, so its construction is checked exactly.
export function assertBuyInstructions(ixs, { creator, mint, devBuyRaw, minTokensOut, quoteTokenProgram }) {
  const bad = () => fail("The initial buy differs from the reviewed amount or wallet. No wallet approval was requested.", 503);
  const user = new PublicKey(creator).toBase58(), m = new PublicKey(mint).toBase58(), quoteProgram = new PublicKey(quoteTokenProgram);
  const trades = ixs.filter((ix) => !isAta(ix));
  if (trades.length !== 1) bad();
  const ix = trades[0], k = ix.keys.map((x) => x.pubkey.toBase58()), data = Buffer.from(ix.data);
  if (
    !ix.programId.equals(pump.PUMP_PROGRAM_ID) ||
    data.length !== 25 ||
    !data.subarray(0, 8).equals(BUY_EXACT_QUOTE_IN_V3) ||
    data.readBigUInt64LE(8) !== BigInt(devBuyRaw) ||
    BigInt(devBuyRaw) <= 0n ||
    data.readBigUInt64LE(16) !== BigInt(minTokensOut) ||
    data[24] !== 0 ||
    k[1] !== m ||
    k[2] !== NEAR ||
    k[3] !== TOKEN_2022_PROGRAM_ID.toBase58() ||
    k[4] !== quoteProgram.toBase58() ||
    k[5] !== pump.bondingCurvePda(new PublicKey(m)).toBase58() ||
    k[8] !== user ||
    k[9] !== getAssociatedTokenAddressSync(new PublicKey(m), new PublicKey(user), true, TOKEN_2022_PROGRAM_ID).toBase58() ||
    k[10] !== getAssociatedTokenAddressSync(new PublicKey(NEAR), new PublicKey(user), true, quoteProgram).toBase58() ||
    ix.keys.some((x, i) => x.isSigner !== (i === 8))
  )
    bad();
  for (const a of ixs.filter(isAta)) {
    const [payer, , owner, asset] = a.keys.map((x) => x.pubkey.toBase58());
    if (
      a.data.length !== 1 ||
      a.data[0] !== 1 ||
      payer !== user ||
      !((asset === m && owner === user) || asset === NEAR)
    )
      bad();
  }
}
export async function launchParts(input, c) {
  const { creator, mint } = input,
    treasury = input.feeTreasury ? new PublicKey(input.feeTreasury) : creator;
  const all = await launchInstructions({
    creator: creator.toBase58(),
    mint: mint.toBase58(),
    treasury: treasury.toBase58(),
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    quote: c.quote,
  });
  const setup = all.filter(isAta),
    create = all.filter((ix) => ix.programId.equals(pump.PUMP_PROGRAM_ID)),
    fees = all.filter((ix) => ix.programId.equals(pump.PUMP_FEE_PROGRAM_ID));
  if (create.length !== 1 || fees.length !== 2 || setup.length + create.length + fees.length !== all.length)
    fail("Pump creation instructions changed. No wallet approval was requested.", 503);
  let buy = [];
  if (input.devBuyRaw > 0n) {
    const { curve, amount } = buyQuote(input, c),
      made = new Set(setup.map((ix) => ix.keys[1].pubkey.toBase58()));
    // Quote accounts already created by setup are not created again.
    buy = (await buyInstructions({ creator, mint, devBuyRaw: input.devBuyRaw, amount, curve, c })).filter(
      (ix) => !isAta(ix) || !made.has(ix.keys[1].pubkey.toBase58()),
    );
  }
  return { setup, create, fees, buy };
}
export function launchMemo(id, record) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [],
    data: Buffer.from(
      "INTENTPAD:v1:" +
        id +
        ":" +
        hash(
          JSON.stringify({
            mint: record.mint,
            creator: record.creator,
            quoteMint: NEAR,
            creatorFeeBps: record.creatorFeeBps,feeTreasury:record.feeTreasury,rewardPolicyHash:record.rewardPolicyHash,
            devBuyRaw: record.devBuyRaw,devBuySolRaw:record.devBuySolRaw,
          }),
        ),
    ),
  });
}
export function compileBundleTx({ payer, blockhash, instructions, computeUnitLimit, tables = [] }) {
  const budget = computeUnitLimit
    ? [
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE_MICROLAMPORTS }),
      ]
    : [];
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [...budget, ...instructions],
  }).compileToV0Message(tables);
  return new VersionedTransaction(message);
}
export function buildBundle({ payer, mint, blockhash, tables = [], setup = [], create, fees, buy = [], memo, tip, conversion = false }) {
  const tipIx = SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(tip.account), lamports: BigInt(tip.lamports) });
  const parts = [
    { role: "setup", instructions: [...setup, memo], units: conversion ? BUNDLE_COMPUTE_UNITS.conversion : BUNDLE_COMPUTE_UNITS.setup },
    { role: "create", instructions: [...create, tipIx], units: null },
    { role: "fees", instructions: [...fees, ...buy], units: BUNDLE_COMPUTE_UNITS.fees },
  ];
  const bundle = parts.map((p) => ({
    role: p.role,
    tx: compileBundleTx({ payer, blockhash, instructions: p.instructions, computeUnitLimit: p.units, tables }),
  }));
  assertBundleShape(bundle, { payer, mint, tipAccount: tip.account, tables });
  return bundle;
}
export const bundleBytes = (tx) => {
  try {
    return tx.serialize().length;
  } catch {
    return Infinity; // web3 refuses to encode more than 1232 bytes
  }
};
// Fails before any wallet approval: size headroom, signer set per part, tip placement.
export function assertBundleShape(bundle, { payer, mint, tipAccount, tables = [] }) {
  const P = new PublicKey(payer).toBase58(), M = new PublicKey(mint).toBase58(), T = new PublicKey(tipAccount).toBase58();
  if (tables.some((t) => t.state.addresses.some((a) => [P, M, T].includes(a.toBase58()))))
    fail("The launch address table contains a signer or tip account. No wallet approval was requested.", 503);
  if (bundle.map((b) => b.role).join() !== "setup,create,fees")
    fail("The launch bundle is malformed. No wallet approval was requested.", 503);
  for (const { role, tx } of bundle) {
    const size = bundleBytes(tx);
    if (size + WALLET_BYTE_ALLOWANCE > MAX_TRANSACTION_BYTES)
      fail("This launch does not leave room for wallet security checks. No wallet approval was requested and no SOL was swapped.", 503);
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58()),
      signers = keys.slice(0, tx.message.header.numRequiredSignatures),
      expected = role === "create" ? [P, M] : [P];
    if (tx.message.version !== 0 || signers[0] !== P || signers.length !== expected.length || expected.some((k) => !signers.includes(k)))
      fail("The launch bundle has unexpected signers. No wallet approval was requested.", 503);
    if ((role === "create") !== keys.includes(T))
      fail("Only the creation transaction may pay the bundle tip. No wallet approval was requested.", 503);
  }
  return bundle;
}
