import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SOL, NEAR } from "../lib/solana-rpc.mjs";
import {
  validateRoute,
  conversionInstructions,
  assertSwapLimits,
} from "../lib/sol-dev-buy.mjs";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const base = {
  inputMint: SOL,
  outputMint: NEAR,
  inAmount: "10000000",
  outAmount: "200000000",
  otherAmountThreshold: "199000000",
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0.001",
  routePlan: [
    {
      percent: 100,
      swapInfo: { label: "Raydium CP", inputMint: SOL, outputMint: NEAR },
    },
  ],
};
test("SOL route binds exact input, minimum output, quote mint, fees and conservative impact", () => {
  validateRoute(base, 10000000n);
  for (const changed of [
    { inputMint: NEAR },
    { outputMint: USDC },
    { inAmount: "10000001" },
    { otherAmountThreshold: "1" },
    { swapMode: "ExactOut" },
    { slippageBps: 100 },
    { platformFee: { amount: "1" } },
    { tipInstruction: {} },
    { priceImpactPct: null },
    { priceImpactPct: "0.02" },
    { otherInstructions: [{}] },
  ])
    assert.throws(() => validateRoute({ ...base, ...changed }, 10000000n));
});
test("only direct NEAR and continuous native USDC intermediary routes are admitted", () => {
  const via = {
    ...base,
    routePlan: [
      {
        percent: 100,
        swapInfo: {
          label: "Raydium CLMM",
          inputMint: SOL,
          outputMint: USDC,
          inAmount: base.inAmount,
          outAmount: "1000",
        },
      },
      {
        percent: 100,
        swapInfo: {
          label: "Raydium CP",
          inputMint: USDC,
          outputMint: NEAR,
          inAmount: "1000",
          outAmount: base.outAmount,
        },
      },
    ],
  };
  validateRoute(via, 10000000n);
  for (const change of [
    (r) => (r.routePlan[1].swapInfo.inAmount = "999"),
    (r) => (r.routePlan[0].swapInfo.label = "Unknown"),
    (r) =>
      (r.routePlan[0].swapInfo.outputMint =
        Keypair.generate().publicKey.toBase58()),
  ]) {
    const r = structuredClone(via);
    change(r);
    assert.throws(() => validateRoute(r, 10000000n));
  }
});
const encoded = () => {
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(10000000n, 0);
  tail.writeBigUInt64LE(200000000n, 8);
  tail.writeUInt16LE(50, 16);
  return Buffer.concat([
    createHash("sha256").update("global:route").digest().subarray(0, 8),
    Buffer.alloc(4),
    tail,
  ]).toString("base64");
};
test("signed swap bytes enforce the exact input and minimum output independently of quote JSON", () => {
  const data = encoded();
  assertSwapLimits(data, base);
  assert.throws(
    () => assertSwapLimits(data, { ...base, inAmount: "20000000" }),
    /Encoded/,
  );
  assert.throws(
    () =>
      assertSwapLimits(data, { ...base, otherAmountThreshold: "200000000" }),
    /Encoded/,
  );
  assert.throws(() => assertSwapLimits("AQ==", base), /format/);
});
const serialize = (ix) => ({
  programId: ix.programId.toBase58(),
  accounts: ix.keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  })),
  data: ix.data.toString("base64"),
});
test("conversion setup cannot debit extra SOL, change authority or operate on the launch mint", () => {
  const user = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey.toBase58(),
    ata = getAssociatedTokenAddressSync(new user.constructor(SOL), user),
    transfer = SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: ata,
      lamports: 10000000,
    }),
    route = {
      ...base,
      setupInstructions: [
        serialize(transfer),
        serialize(createSyncNativeInstruction(ata)),
      ],
      swapInstruction: {
        programId: JUP,
        accounts: [
          TOKEN_PROGRAM_ID.toBase58(),
          user.toBase58(),
          ata.toBase58(),
          getAssociatedTokenAddressSync(
            new user.constructor(NEAR),
            user,
          ).toBase58(),
          JUP,
          NEAR,
        ].map((pubkey, i) => ({
          pubkey,
          isSigner: i === 1,
          isWritable: i === 2 || i === 3,
        })),
        data: encoded(),
      },
    };
  assert.equal(
    conversionInstructions(route, user.toBase58(), "10000000", { mint }).length,
    3,
  );
  assert.throws(
    () => conversionInstructions(route, user.toBase58(), "9999999", { mint }),
    /spending cap/,
  );
  assert.throws(
    () =>
      conversionInstructions(
        {
          ...route,
          swapInstruction: {
            ...route.swapInstruction,
            accounts: [{ pubkey: mint, isSigner: false, isWritable: true }],
          },
        },
        user.toBase58(),
        "10000000",
        { mint },
      ),
    /authority|source/,
  );
  const debit = serialize(
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: transfer.keys,
      data: Buffer.from([1]),
    }),
  );
  assert.throws(() =>
    conversionInstructions(
      { ...route, setupInstructions: [debit] },
      user.toBase58(),
      "10000000",
      { mint },
    ),
  );
});

test("V2 routes enforce header amounts and reject positive-slippage diversion", () => {
  for (const shared of [false, true]) {
    const name = shared ? "shared_accounts_route_v2" : "route_v2",
      offset = shared ? 9 : 8,
      bytes = Buffer.alloc(offset + 26);
    discriminatorInto(bytes, name);
    bytes.writeBigUInt64LE(10000000n, offset);
    bytes.writeBigUInt64LE(200000000n, offset + 8);
    bytes.writeUInt16LE(50, offset + 16);
    assertSwapLimits(bytes.toString("base64"), base);
    bytes.writeUInt16LE(1, offset + 20);
    assert.throws(
      () => assertSwapLimits(bytes.toString("base64"), base),
      /Encoded/,
    );
  }
});
function discriminatorInto(bytes, name) {
  createHash("sha256")
    .update("global:" + name)
    .digest()
    .copy(bytes, 0, 0, 8);
}
test("a venue with an intermediary route is skipped, and exhausting venues gives the user-facing message", async () => {
  const { solConversion } = await import("../lib/sol-dev-buy.mjs");
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const viaOther = (label) => ({
    ...base,
    routePlan: [
      { percent: 100, swapInfo: { label, inputMint: SOL, outputMint: BONK, inAmount: base.inAmount, outAmount: "5" } },
      { percent: 100, swapInfo: { label, inputMint: BONK, outputMint: NEAR, inAmount: "5", outAmount: base.outAmount } },
    ],
  });
  const asked = [];
  const transport = async (u) => {
    const venue = new URL(u).searchParams.get("dexes");
    asked.push(venue);
    if (venue === "Raydium CP") return { status: 400, ok: false, json: async () => ({ error: "No routes found" }) };
    return { status: 200, ok: true, json: async () => viaOther(venue) };
  };
  await assert.rejects(
    solConversion(Keypair.generate().publicKey.toBase58(), 10000000n, { transport }),
    (e) => e.safe === true && e.status === 503 && /No bounded direct SOL-to-NEAR route/.test(e.message),
  );
  assert.deepEqual(asked, ["Raydium CLMM", "Raydium CP", "Meteora DLMM"]);
});
