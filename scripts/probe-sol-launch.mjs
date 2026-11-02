// Read-only mainnet simulations. Nothing is signed or broadcast. Creation
// simulation uses the probe wallet's EXISTING NEAR, never fictitious swap credit.
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
} from "@solana/spl-token";
import {pump} from "../lib/pump-adapter.mjs";
import { context, instructions } from "../server/pump-launch.js";
import {
  solConversion,
  walletTokenState,
  verifyConversionEffects,
} from "../lib/sol-dev-buy.mjs";
import { compileLaunchV1 } from "../lib/launch-wire.mjs";
import { NEAR } from "../lib/solana-rpc.mjs";
const creator = new PublicKey(process.argv[2]),
  feeTreasury = Keypair.generate().publicKey.toBase58(),
  mint = Keypair.generate().publicKey,
  devBuySolRaw = BigInt(process.argv[3] || "10000000"),
  c = await context(30),
  conversion = await solConversion(creator.toBase58(), devBuySolRaw, {
    mint: mint.toBase58(),
    treasury: feeTreasury,
  }),
  tracked = await walletTokenState(
    c.rpc,
    creator.toBase58(),
    new Set(
      conversion.instructions.flatMap((ix) =>
        ix.keys.map((k) => k.pubkey.toBase58()),
      ),
    ),
  ),
  addresses = [
    ...new Set([
      ...tracked.map((r) => r.address),
      getAssociatedTokenAddressSync(new PublicKey(NEAR), creator).toBase58(),
    ]),
  ];
const latest = await c.rpc.getLatestBlockhashAndContext("confirmed"),
  swap = compileLaunchV1({
    payer: creator,
    latest: latest.value,
    instructions: conversion.instructions,
    computeUnitLimit: 1000000,
  }),
  sim = await c.rpc.simulateTransaction(swap, {
    sigVerify: false,
    commitment: "confirmed",
    minContextSlot: latest.context.slot,
    accounts: {
      encoding: "base64",
      addresses: [creator.toBase58(), ...addresses],
    },
  });
if (sim.value.err)
  throw Error("Unsigned conversion failed: " + JSON.stringify(sim.value.err));
verifyConversionEffects(
  tracked,
  new Map(addresses.map((a, i) => [a, sim.value.accounts[i + 1]])),
  {
    creator: creator.toBase58(),
    mint: mint.toBase58(),
    minimumRaw: conversion.minimumRaw,
  },
);
console.log(
  JSON.stringify({
    phase: "SOL conversion",
    success: true,
    unsigned: true,
    buySolRaw: String(devBuySolRaw),
    minimumNearRaw: conversion.minimumRaw,
    wireBytes: swap.serialize().length,
    units: sim.value.unitsConsumed,
    existingAssetsPreserved: true,
  }),
);
const launch = await instructions(
    {
      creator,
      mint,
      name: "Unsigned Intent Probe",
      symbol: "PROBE",
      uri: "https://example.com/unsigned-only.json",
      devBuyRaw: process.argv.includes("--zero-buy")
        ? 0n
        : BigInt(conversion.minimumRaw),
      creatorFeeBps: 30,
      feeTreasury,
    },
    c,
  ),
  block = await c.rpc.getLatestBlockhashAndContext("confirmed"),
  tx = compileLaunchV1({
    payer: creator,
    latest: block.value,
    instructions: launch,
    computeUnitLimit: 1400000,
  }),
  purchased = getAssociatedTokenAddressSync(
    mint,
    creator,
    false,
    TOKEN_2022_PROGRAM_ID,
  ),
  result = await c.rpc.simulateTransaction(tx, {
    sigVerify: false,
    commitment: "confirmed",
    minContextSlot: block.context.slot,
    accounts: { encoding: "base64", addresses: [purchased.toBase58()] },
  });
if (result.value.err) {
  console.log(
    JSON.stringify({
      phase: "creation and initial buy",
      success: false,
      error: result.value.err,
      logs: result.value.logs?.slice(-12),
    }),
  );
  process.exitCode = 1;
} else {
  const r = result.value.accounts[0],
    a = r
      ? unpackAccount(
          purchased,
          {
            ...r,
            owner: new PublicKey(r.owner),
            data: Buffer.from(r.data[0], "base64"),
          },
          TOKEN_2022_PROGRAM_ID,
        )
      : { amount: 0n };
  if (a.amount <= 0n && !process.argv.includes("--zero-buy"))
    throw Error("No purchased tokens");
  const decodeInfo=r=>({...r,owner:new PublicKey(r.owner),data:Buffer.from(r.data[0],'base64')}),shares=pump.PUMP_SDK.decodeSharingConfig(decodeInfo(result.value.accounts[1])),curve=pump.PUMP_SDK.decodeBondingCurve(decodeInfo(result.value.accounts[2]));
  if(shares.shareholders.length!==1||shares.shareholders[0].address.toBase58()!==feeTreasury||shares.shareholders[0].shareBps!==10000||pump.isSharingConfigEditable({sharingConfig:shares})||curve.quoteMint.toBase58()!==NEAR)throw Error('Simulated immutable fee destination differs from the review.');
  console.log(
    JSON.stringify({
      phase: process.argv.includes("--zero-buy")
        ? "creation without initial buy"
        : "creation and initial buy",
      success: true,
      unsigned: true,
      existingNearUsed: true,
      purchasedTokenRaw: String(a.amount),
      wireBytes: tx.serialize().length,
      units: result.value.unitsConsumed,
      treasurySeparate: true,
    }),
  );
}
