import { createHash } from "node:crypto";
// Penny's bounded SOL conversion, adapted to Intent's verified NEAR mint.
// New launches compose this exact-input conversion with creation and the buy.
// Legacy finalized conversion receipts remain valid for recovery.
import {
  PublicKey,
  SystemProgram,
  SystemInstruction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  unpackAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SOL, NEAR } from "./solana-rpc.mjs";
import { fail } from "./http.js";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const VENUES = ["Meteora DLMM", "Raydium CLMM", "Raydium CP"];
const positive = (v) => typeof v === "string" && /^[1-9]\d*$/.test(v);
export function validateRoute(r, raw) {
  if (
    r?.inputMint !== SOL ||
    r.outputMint !== NEAR ||
    r.inAmount !== String(raw) ||
    r.swapMode !== "ExactIn" ||
    r.slippageBps !== 50 ||
    !positive(r.outAmount) ||
    !positive(r.otherAmountThreshold) ||
    BigInt(r.otherAmountThreshold) < (BigInt(r.outAmount) * 9950n) / 10000n ||
    BigInt(r.otherAmountThreshold) >
      (BigInt(r.outAmount) * 9950n + 9999n) / 10000n ||
    r.tipInstruction ||
    (r.otherInstructions?.length ?? 0) !== 0 ||
    (r.platformFee?.amount && r.platformFee.amount !== "0")
  )
    throw Error("SOL conversion differs from the reviewed purchase.");
  const impact = Number(r.priceImpactPct);
  if (
    r.priceImpactPct === null ||
    r.priceImpactPct === undefined ||
    r.priceImpactPct === "" ||
    !Number.isFinite(impact) ||
    Math.abs(impact) > 0.01
  )
    throw Error("SOL conversion price impact exceeds 1% or is unavailable.");
  const hops = r.routePlan;
  if (
    !Array.isArray(hops) ||
    !hops.length ||
    hops.some((h) => !VENUES.includes(h?.swapInfo?.label))
  )
    throw Error("Unsupported SOL conversion venue.");
  const direct = hops.every(
    (h) => h.swapInfo.inputMint === SOL && h.swapInfo.outputMint === NEAR,
  );
  const [a, b] = hops.map((h) => h.swapInfo);
  const viaUsdc =
    hops.length === 2 &&
    hops.every(
      (h) =>
        (h.percent === undefined || h.percent === 100) &&
        (h.bps === undefined || h.bps === 10000),
    ) &&
    a.inputMint === SOL &&
    a.outputMint === USDC &&
    b.inputMint === USDC &&
    b.outputMint === NEAR &&
    a.inAmount === String(raw) &&
    a.outAmount === b.inAmount &&
    b.outAmount === r.outAmount;
  if (!direct && !viaUsdc)
    throw Error("SOL conversion uses an unsupported intermediary.");
  return r;
}
// V2 layout verified against Jupiter's program-owned mainnet Anchor IDL:
// C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa, SHA256
// e6c2b425ec740922ee91aa7a3278cea07f4bc00a3ed9efa4eca16facb481bfca.
const discriminator = (name) =>
  createHash("sha256")
    .update("global:" + name)
    .digest()
    .subarray(0, 8);
export function assertSwapLimits(data, route) {
  const bytes = Buffer.from(data, "base64"),
    name = [
      "route",
      "shared_accounts_route",
      "route_v2",
      "shared_accounts_route_v2",
    ].find((n) => discriminator(n).equals(bytes.subarray(0, 8)));
  if (!name || bytes.length < 31)
    throw Error("Unsupported encoded SOL swap format.");
  let input,
    quoted,
    slippage,
    fee,
    positive = 0;
  if (name.endsWith("_v2")) {
    const offset = name.startsWith("shared_") ? 9 : 8;
    if (bytes.length < offset + 26)
      throw Error("Unsupported encoded SOL swap format.");
    input = bytes.readBigUInt64LE(offset);
    quoted = bytes.readBigUInt64LE(offset + 8);
    slippage = bytes.readUInt16LE(offset + 16);
    fee = bytes.readUInt16LE(offset + 18);
    positive = bytes.readUInt16LE(offset + 20);
  } else {
    const t = bytes.subarray(-19);
    input = t.readBigUInt64LE(0);
    quoted = t.readBigUInt64LE(8);
    slippage = t.readUInt16LE(16);
    fee = t[18];
  }
  if (
    input !== BigInt(route.inAmount) ||
    quoted !== BigInt(route.outAmount) ||
    slippage !== 50 ||
    fee !== 0 ||
    positive !== 0 ||
    (quoted * 9950n + 9999n) / 10000n < BigInt(route.otherAmountThreshold)
  )
    throw Error(
      "Encoded SOL swap spending or output floor differs from the quote.",
    );
  return name;
}
export function assertSwapAccounts(ix, creator, name) {
  const k = ix.accounts.map((a) => a.pubkey),
    wsol = getAssociatedTokenAddressSync(
      new PublicKey(SOL),
      new PublicKey(creator),
    ).toBase58(),
    near = getAssociatedTokenAddressSync(
      new PublicKey(NEAR),
      new PublicKey(creator),
    ).toBase58(),
    p = TOKEN_PROGRAM_ID.toBase58();
  let expected;
  if (name === "route_v2")
    expected = { 0: creator, 1: wsol, 2: near, 3: SOL, 4: NEAR, 5: p, 6: p };
  else if (name === "shared_accounts_route_v2")
    expected = { 1: creator, 2: wsol, 5: near, 6: SOL, 7: NEAR, 8: p, 9: p };
  else if (name === "route")
    expected = { 0: p, 1: creator, 2: wsol, 3: near, 5: NEAR };
  else expected = { 0: p, 2: creator, 3: wsol, 6: near, 7: SOL, 8: NEAR };
  if (Object.entries(expected).some(([i, v]) => k[Number(i)] !== v))
    throw Error(
      "Encoded SOL conversion source or recipient differs from the review.",
    );
  if (name === "route_v2" && ![JUP, near].includes(k[7]))
    throw Error("Unexpected alternate SOL conversion destination.");
}
export function conversionInstructions(
  route,
  creator,
  raw,
  { mint, treasury } = {},
) {
  const user = new PublicKey(creator),
    wsol = getAssociatedTokenAddressSync(new PublicKey(SOL), user);
  let wraps = 0;
  const variant = assertSwapLimits(route.swapInstruction?.data || "", route);
  assertSwapAccounts(route.swapInstruction, creator, variant);
  if (route.swapInstruction?.programId !== JUP)
    throw Error("Unsupported SOL conversion program.");
  const rows = [
    ...(route.setupInstructions || []),
    route.swapInstruction,
    ...(route.cleanupInstruction ? [route.cleanupInstruction] : []),
  ];
  return rows
    .map((ix) => {
      if (
        ![
          JUP,
          SystemProgram.programId.toBase58(),
          TOKEN_PROGRAM_ID.toBase58(),
          ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
        ].includes(ix?.programId) ||
        !Array.isArray(ix.accounts) ||
        ix.accounts.length > 100 ||
        typeof ix.data !== "string" ||
        ix.data.length > 4000 ||
        ix.accounts.some(
          (a) =>
            (a.isSigner && a.pubkey !== creator) ||
            a.pubkey === mint ||
            (treasury !== creator && a.pubkey === treasury),
        )
      )
        throw Error(
          "SOL conversion account authority differs from the launching wallet.",
        );
      const out = new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.accounts.map((a) => ({
          pubkey: new PublicKey(a.pubkey),
          isSigner: a.isSigner === true,
          isWritable: a.isWritable === true,
        })),
        data: Buffer.from(ix.data, "base64"),
      });
      if (out.programId.equals(SystemProgram.programId)) {
        if (SystemInstruction.decodeInstructionType(out) !== "Transfer")
          throw Error("Unsupported SOL setup debit.");
        const t = SystemInstruction.decodeTransfer(out);
        if (
          !t.fromPubkey.equals(user) ||
          !t.toPubkey.equals(wsol) ||
          BigInt(t.lamports) !== BigInt(raw)
        )
          throw Error("SOL input exceeds its exact spending cap.");
        wraps++;
      } else if (out.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
        const [payer, ata, owner, asset, , program] = out.keys.map(
          (k) => k.pubkey,
        );
        if (
          !payer?.equals(user) ||
          !owner?.equals(user) ||
          ![SOL, NEAR, USDC].includes(asset?.toBase58()) ||
          !program?.equals(TOKEN_PROGRAM_ID) ||
          !ata?.equals(getAssociatedTokenAddressSync(asset, user)) ||
          out.data.length > 1 ||
          ![0, 1].includes(out.data[0] ?? 0)
        )
          throw Error("Unexpected conversion token account.");
      } else if (out.programId.equals(TOKEN_PROGRAM_ID)) {
        if (
          !out.keys[0]?.pubkey.equals(wsol) ||
          !(
            (out.data[0] === 17 && out.data.length === 1) ||
            (out.data[0] === 9 &&
              out.data.length === 1 &&
              out.keys[1]?.pubkey.equals(user) &&
              out.keys[2]?.pubkey.equals(user))
          )
        )
          throw Error("Unsupported conversion token instruction.");
      }
      return out;
    })
    .map((ix, i, all) => {
      if (i === all.length - 1 && wraps !== 1)
        throw Error("SOL conversion must wrap exactly the entered amount.");
      return ix;
    });
}
export async function solConversion(creator, raw, options = {}) {
  // Prefer a single public-pool hop: extra hops can exceed Solana's CPI trace
  // limit when composed with create + immutable fee setup + initial buy.
  for (const venue of ["Raydium CLMM", "Raydium CP", "Meteora DLMM"]) {
    const u = new URL("https://api.jup.ag/swap/v2/build");
    for (const [k, v] of Object.entries({
      inputMint: SOL,
      outputMint: NEAR,
      amount: String(raw),
      taker: creator,
      slippageBps: "50",
      maxAccounts: "32",
      dexes: venue,
    }))
      u.searchParams.set(k, v);
    const r = await (options.transport || fetch)(u, {
      headers: process.env.JUPITER_API_KEY
        ? { "x-api-key": process.env.JUPITER_API_KEY }
        : {},
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
      redirect: "error",
    });
    if (r.status === 400) continue;
    if (!r.ok)
      fail(
        "SOL conversion route unavailable. No payment was requested; retry or enter 0 to launch without a buy.",
        503,
      );
    // A venue can return a multi-hop, split or high-impact route; that only rules out this venue.
    let route;
    try {
      route = validateRoute(await r.json(), raw);
    } catch {
      continue;
    }
    if (
      !route.routePlan.every(
        (h) => h.swapInfo.inputMint === SOL && h.swapInfo.outputMint === NEAR,
      )
    )
      continue;
    return {
      instructions: conversionInstructions(route, creator, raw, options),
      minimumRaw: String((BigInt(route.outAmount) * 9950n) / 10000n),
      quotedRaw: route.outAmount,
    };
  }
  fail(
    "No bounded direct SOL-to-NEAR route is available for this initial buy. No payment was requested. Retry or enter 0 to create without a buy.",
    503,
  );
}
// All existing wallet-owned accounts are tracked. No unrelated token debit,
// authority change, delegate, or account closure can hide inside the route.
export async function walletTokenState(rpc, creator, addresses) {
  const user = new PublicKey(creator),
    keys = [...addresses].map((k) => new PublicKey(k));
  if (keys.length > 100)
    throw Error("SOL route exceeds the bounded account review.");
  const infos = await rpc.getMultipleAccountsInfo(keys, "confirmed"),
    rows = [];
  for (let i = 0; i < keys.length; i++) {
    const info = infos[i];
    if (
      !info ||
      ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((p) =>
        p.equals(info.owner),
      ) ||
      info.data.length < 165
    )
      continue;
    let state;
    try {
      state = unpackAccount(keys[i], info, info.owner);
    } catch {
      continue;
    }
    if (state.owner.equals(user))
      rows.push({ address: keys[i].toBase58(), program: info.owner, state });
  }
  return rows;
}

export function verifyConversionEffects(
  before,
  after,
  { creator, mint, minimumRaw, atomicBuy = false },
) {
  const near = getAssociatedTokenAddressSync(
    new PublicKey(NEAR),
    new PublicKey(creator),
  ).toBase58();
  for (const row of before) {
    if (row.state.mint.toBase58() === SOL && row.state.amount > 0n)
      throw Error(
        "Unwrap existing wrapped SOL before using a SOL initial buy.",
      );
    const raw = after.get(row.address);
    if (!raw) {
      if (row.state.mint.toBase58() === SOL && row.state.amount === 0n)
        continue;
      throw Error("Conversion closed an existing token account.");
    }
    const next = unpackAccount(
      new PublicKey(row.address),
      {
        ...raw,
        owner: new PublicKey(raw.owner),
        data: Buffer.from(raw.data[0], "base64"),
      },
      row.program,
    );
    if (
      !next.owner.equals(row.state.owner) ||
      !next.mint.equals(row.state.mint) ||
      next.isFrozen !== row.state.isFrozen ||
      String(next.delegate) !== String(row.state.delegate) ||
      next.delegatedAmount !== row.state.delegatedAmount ||
      String(next.closeAuthority) !== String(row.state.closeAuthority) ||
      next.amount < row.state.amount
    )
      throw Error("Conversion changed existing wallet assets or permissions.");
  }
  const output = after.get(near);
  if (!output) throw Error("Conversion output account missing.");
  const final = unpackAccount(
    new PublicKey(near),
    {
      ...output,
      owner: new PublicKey(output.owner),
      data: Buffer.from(output.data[0], "base64"),
    },
    TOKEN_PROGRAM_ID,
  );
  const prior = before.find((r) => r.address === near)?.state.amount || 0n;
  // A standalone legacy conversion credits its full floor. An atomic launch
  // spends that output in the reviewed buy, but may never consume prior NEAR.
  if (
    final.amount - prior < BigInt(minimumRaw) ||
    final.mint.toBase58() !== NEAR ||
    final.owner.toBase58() !== creator ||
    final.delegate ||
    final.closeAuthority ||
    final.isFrozen ||
    (atomicBuy ? BigInt(minimumRaw) !== 0n : BigInt(minimumRaw) <= 0n) ||
    !mint
  )
    throw Error(
      "SOL conversion did not preserve the launching wallet’s assets.",
    );
}
