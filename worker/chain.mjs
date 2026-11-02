import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  unpackAccount,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import { pump, verifyFeeAssignment } from "../lib/pump-adapter.mjs";
import {
  compileLaunchV1,
  readLaunchReceipt,
  decodeLaunchTransaction,
} from "../lib/launch-wire.mjs";
import { cloutPaymentSignature } from "../lib/launch-signatures.mjs";
import { NEAR } from "../lib/solana-rpc.mjs";
import { REWARD_POLICY } from "../lib/reward-policy.mjs";
export const PROTECTED_SOL = 20000000n,
  MAX_SOL_COST = 25000000n;
export function operatorKey(secret, expected) {
  try {
    const input = secret?.trim();
    if (!input || input.length > 1024) throw Error();
    let bytes;
    if (input.startsWith("[")) {
      const a = JSON.parse(input);
      if (
        !Array.isArray(a) ||
        a.length !== 64 ||
        a.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
      )
        throw Error();
      bytes = Uint8Array.from(a);
    } else bytes = bs58.decode(input);
    if (bytes.length !== 64) throw Error();
    const pair = Keypair.fromSecretKey(bytes);
    bytes.fill(0);
    if (pair.publicKey.toBase58() !== expected) throw Error();
    return pair;
  } catch {
    throw Error(
      "Operator signing key is missing or does not match INTENT_TREASURY_ADDRESS.",
    );
  }
}
export const nearAta = (owner) =>
  getAssociatedTokenAddressSync(
    new PublicKey(NEAR),
    new PublicKey(owner),
    false,
    TOKEN_PROGRAM_ID,
  );
export async function nearBalance(rpc, owner) {
  const ata = nearAta(owner),
    info = await rpc.getAccountInfo(ata, "finalized");
  if (
    !info ||
    (info.owner.equals(SystemProgram.programId) && info.data.length === 0)
  )
    return 0n;
  const a = unpackAccount(ata, info, TOKEN_PROGRAM_ID);
  if (a.isFrozen || a.owner.toBase58() !== owner || a.mint.toBase58() !== NEAR)
    throw Error("Invalid reward token account.");
  return a.amount;
}
async function prepareTransaction(
  rpc,
  key,
  instructions,
  plan,
  { incomingMin = 0n } = {},
) {
  const treasury = key.publicKey.toBase58(),
    before = await rpc.getBalanceAndContext(key.publicKey, "confirmed");
  if (BigInt(before.value) < PROTECTED_SOL + 1000000n)
    throw Error("Operator needs SOL above its protected 0.02 SOL reserve.");
  const latest = await rpc.getLatestBlockhash("confirmed"),
    tx = compileLaunchV1({
      payer: key.publicKey,
      latest,
      instructions,
      computeUnitLimit: 1200000,
    }),
    ata = nearAta(treasury),
    prior = await nearBalance(rpc, treasury),
    sim = await rpc.simulateTransaction(tx, {
      sigVerify: false,
      commitment: "confirmed",
      minContextSlot: before.context.slot,
      accounts: { encoding: "base64", addresses: [treasury, ata.toBase58()] },
    });
  if (
    sim.value.err ||
    sim.context.slot < before.context.slot ||
    !Number.isSafeInteger(sim.value.accounts?.[0]?.lamports)
  )
    throw Error("Reward transaction simulation failed.");
  const after = sim.value.accounts[0].lamports,
    cost = BigInt(before.value - after),
    raw = sim.value.accounts?.[1],
    post = raw
      ? unpackAccount(
          ata,
          {
            ...raw,
            owner: new PublicKey(raw.owner),
            data: Buffer.from(raw.data[0], "base64"),
          },
          TOKEN_PROGRAM_ID,
        ).amount
      : 0n;
  if (plan.kind === "claim" && post - prior < incomingMin) return null;
  if (
    plan.kind === "payout" &&
    prior - post !== plan.rows.reduce((n, r) => n + BigInt(r.raw), 0n)
  )
    throw Error("Payout simulation differs from its reserved credits.");
  if (cost < 0n || cost > MAX_SOL_COST || BigInt(after) < PROTECTED_SOL)
    throw Error("Reward transaction exceeds the operator SOL budget.");
  tx.sign([key]);
  const wire = Buffer.from(tx.serialize()),
    signature = cloutPaymentSignature(wire);
  return {
    signature,
    wire: wire.toString("base64"),
    last_valid: latest.lastValidBlockHeight,
    plan: { ...plan, treasury, maxSolDebit: String(cost + 500000n) },
  };
}
export async function prepareClaim(rpc, key, coin) {
  await verifyFeeAssignment(
    rpc,
    coin.mint,
    key.publicKey.toBase58(),
    NEAR,
    coin.creatorFeeBps,
  );
  const online = new pump.OnlinePumpSdk(rpc),
    build = await online.buildDistributeCreatorFeesInstructions(
      new PublicKey(coin.mint),
      {
        quoteMint: new PublicKey(NEAR),
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        payer: key.publicKey,
      },
    );
  return prepareTransaction(
    rpc,
    key,
    build.instructions,
    { kind: "claim", mint: coin.mint },
    { incomingMin: BigInt(REWARD_POLICY.minClaimRaw) },
  );
}
export async function preparePayout(rpc, key, mint, credits) {
  if (!credits.length) return null;
  const rows = [],
    instructions = [],
    source = nearAta(key.publicKey.toBase58()),
    infos = await rpc.getMultipleAccountsInfo(
      credits.map((c) => nearAta(c.owner)),
      "finalized",
    );
  for (const [index, credit] of credits.entries()) {
    if (rows.length === 10) break;
    const owner = new PublicKey(credit.owner);
    if (!PublicKey.isOnCurve(owner.toBytes()) || owner.equals(key.publicKey))
      throw Error("Invalid payout recipient.");
    const ata = nearAta(credit.owner),
      rawInfo = infos[index],
      info =
        rawInfo?.owner.equals(SystemProgram.programId) &&
        rawInfo.data.length === 0
          ? null
          : rawInfo,
      minimum = BigInt(
        info
          ? REWARD_POLICY.minExistingAtaPayoutRaw
          : REWARD_POLICY.minNewAtaPayoutRaw,
      );
    if (BigInt(credit.raw) < minimum) continue;
    if (info) {
      const account = unpackAccount(ata, info, TOKEN_PROGRAM_ID);
      if (
        account.isFrozen ||
        !account.owner.equals(owner) ||
        account.mint.toBase58() !== NEAR
      )
        throw Error("Recipient reward account is invalid.");
    } else
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          key.publicKey,
          ata,
          owner,
          new PublicKey(NEAR),
          TOKEN_PROGRAM_ID,
        ),
      );
    instructions.push(
      createTransferCheckedInstruction(
        source,
        new PublicKey(NEAR),
        ata,
        key.publicKey,
        BigInt(credit.raw),
        9,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );
    rows.push({ owner: credit.owner, raw: credit.raw, ata: ata.toBase58() });
  }
  if (!rows.length) return null;
  return prepareTransaction(rpc, key, instructions, {
    kind: "payout",
    mint,
    rows,
  });
}
// Same scoped Pump event authentication as Penny's creator-fee receipt adapter.
export function distributionEvents(logs) {
  const stack = [],
    out = [];
  for (const line of logs || []) {
    const enter = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(
      line,
    );
    if (enter) {
      stack.length = Number(enter[2]) - 1;
      stack.push(enter[1]);
      continue;
    }
    const leave =
      /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:.*)$/.exec(line);
    if (leave) {
      if (stack.at(-1) !== leave[1])
        throw Error("Inconsistent program event scope.");
      stack.pop();
      continue;
    }
    if (
      stack.at(-1) !== pump.PUMP_PROGRAM_ID.toBase58() ||
      !line.startsWith("Program data: ")
    )
      continue;
    const bytes = Buffer.from(line.slice(14), "base64");
    if (
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([165, 55, 129, 112, 4, 179, 202, 40]))
    )
      out.push(
        pump.PUMP_SDK.decodeDistributeCreatorFeesEvent(bytes.subarray(8)),
      );
  }
  return out;
}
function tokenAmount(tx, address, rows) {
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses,
  });
  const found = rows.filter(
    (r) => keys.get(r.accountIndex)?.toBase58() === address,
  );
  if (found.length > 1) throw Error("Duplicate receipt token account.");
  if (!found.length) return 0n;
  const r = found[0];
  if (r.mint !== NEAR || !/^\d+$/.test(r.uiTokenAmount?.amount || ""))
    throw Error("Unexpected reward receipt asset.");
  return BigInt(r.uiTokenAmount.amount);
}
export function verifyJobReceipt(tx, job) {
  const plan = JSON.parse(job.plan);
  if (!tx?.meta || tx.meta.err !== null)
    throw Error("Successful finalized receipt is required.");
  const expected = decodeLaunchTransaction(
      Buffer.from(job.wire, "base64"),
    ).message.serialize(),
    actual = tx.transaction.message.serialize();
  if (!Buffer.from(expected).equals(Buffer.from(actual)))
    throw Error("Receipt differs from the durable signed job.");
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses,
  });
  if (keys.get(0)?.toBase58() !== plan.treasury)
    throw Error("Unexpected reward transaction payer.");
  const debit =
    BigInt(tx.meta.preBalances[0]) - BigInt(tx.meta.postBalances[0]);
  if (
    debit < 0n ||
    debit > BigInt(plan.maxSolDebit) ||
    debit > MAX_SOL_COST ||
    BigInt(tx.meta.postBalances[0]) < PROTECTED_SOL
  )
    throw Error("Final reward SOL cost exceeds its budget.");
  const source = nearAta(plan.treasury).toBase58(),
    delta =
      tokenAmount(tx, source, tx.meta.postTokenBalances) -
      tokenAmount(tx, source, tx.meta.preTokenBalances);
  if (plan.kind === "claim") {
    const matches = distributionEvents(tx.meta.logMessages).filter(
      (e) => e.mint.toBase58() === plan.mint,
    );
    if (matches.length !== 1)
      throw Error("Missing unique authenticated fee distribution.");
    const e = matches[0];
    if (
      !e.sharingConfig.equals(
        pump.feeSharingConfigPda(new PublicKey(plan.mint)),
      ) ||
      pump.normalizeQuoteMint(e.quoteMint).toBase58() !== NEAR ||
      e.shareholders.length !== 1 ||
      e.shareholders[0].address.toBase58() !== plan.treasury ||
      e.shareholders[0].shareBps !== 10000 ||
      delta !== BigInt(e.distributed.toString()) ||
      delta < 0n
    )
      throw Error("Creator-fee credit does not reconcile.");
    return { raw: String(delta) };
  }
  const total = plan.rows.reduce((n, r) => n + BigInt(r.raw), 0n);
  if (delta !== -total)
    throw Error("Treasury payout debit does not match reserved credits.");
  for (const row of plan.rows)
    if (
      tokenAmount(tx, row.ata, tx.meta.postTokenBalances) -
        tokenAmount(tx, row.ata, tx.meta.preTokenBalances) !==
      BigInt(row.raw)
    )
      throw Error("Recipient did not receive the exact reward.");
  return { rows: plan.rows };
}
export async function finalizedJob(rpc, job) {
  const status = (
    await rpc.getSignatureStatuses([job.signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
  if (status?.err) return { status: "failed" };
  if (status?.confirmationStatus === "finalized") {
    const receipt = await readLaunchReceipt(rpc, job.signature);
    return { status: "confirmed", result: verifyJobReceipt(receipt, job) };
  }
  if (status) return { status: "pending" };
  if ((await rpc.getBlockHeight("finalized")) > job.last_valid)
    return { status: "review" };
  return { status: "broadcast" };
}
