import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import {
  REWARD_POLICY,
  epochStart,
  splitClaim,
  proportional,
  reserveRelease,
  usdCents,
} from "../lib/reward-policy.mjs";
import { POLICY_HASH } from "../lib/reward-readiness.mjs";
import { allReceipts } from "../lib/store.js";
import { NEAR } from "../lib/solana-rpc.mjs";
import { holderSnapshot } from "./snapshot.mjs";
import {
  nearBalance,
  prepareClaim,
  preparePayout,
  finalizedJob,
} from "./chain.mjs";
const integerSum = (rows) => rows.reduce((n, r) => n + BigInt(r.raw), 0n);
export function registerCoin(j, coin, treasury) {
  if (
    coin.feeTreasury !== treasury ||
    coin.rewardPolicyHash !== POLICY_HASH ||
    coin.quoteMint !== NEAR ||
    !coin.signature
  )
    return false;
  j.db
    .prepare("INSERT OR IGNORE INTO coins(mint,treasury) VALUES(?,?)")
    .run(coin.mint, treasury);
  return true;
}
export function reserveJob(j, mint, kind, prepared, now) {
  const id = randomUUID(),
    plan = JSON.stringify(prepared.plan);
  return j.atomic(() => {
    if (j.pending())
      throw Error("An unresolved transaction already owns the outbox.");
    if (kind === "payout")
      for (const r of prepared.plan.rows)
        j.credit(mint, r.owner, -BigInt(r.raw));
    j.db
      .prepare(
        "INSERT INTO jobs(id,mint,kind,signature,wire,last_valid,plan,created) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        mint,
        kind,
        prepared.signature,
        prepared.wire,
        prepared.last_valid,
        plan,
        now,
      );
    return j.pending();
  });
}
export function settleJob(j, job, outcome, now) {
  return j.atomic(() => {
    const live = j.db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id);
    if (!live || !["pending", "review"].includes(live.status)) return;
    const plan = JSON.parse(live.plan);
    if (outcome.status === "review") {
      j.db.prepare("UPDATE jobs SET status='review' WHERE id=?").run(job.id);
      return;
    }
    if (outcome.status === "failed") {
      if (job.kind === "payout")
        for (const r of plan.rows) j.credit(job.mint, r.owner, r.raw);
      j.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id);
      return;
    }
    if (outcome.status !== "confirmed")
      throw Error("Cannot settle an unconfirmed job.");
    if (job.kind === "claim") {
      const raw = BigInt(outcome.result.raw),
        split = splitClaim(raw),
        coin = j.coin(job.mint);
      if (raw > 0n) {
        j.db
          .prepare(
            "INSERT INTO claims(signature,mint,raw,holders,reserve,time) VALUES(?,?,?,?,?,?)",
          )
          .run(
            job.signature,
            job.mint,
            String(raw),
            split.holdersRaw,
            split.reserveRaw,
            now,
          );
        j.db
          .prepare("UPDATE coins SET available=?,reserve=? WHERE mint=?")
          .run(
            String(BigInt(coin.available) + BigInt(split.holdersRaw)),
            String(BigInt(coin.reserve) + BigInt(split.reserveRaw)),
            job.mint,
          );
      }
    } else
      for (const r of outcome.result.rows)
        j.db
          .prepare(
            "INSERT INTO payouts(signature,mint,owner,raw,time) VALUES(?,?,?,?,?)",
          )
          .run(job.signature, job.mint, r.owner, r.raw, now);
    j.db.prepare("UPDATE jobs SET status='confirmed' WHERE id=?").run(job.id);
  });
}
export function allocateEpoch(j, mint, epoch, snapshot, volume) {
  return j.atomic(() => {
    let coin = j.coin(mint);
    if (coin.last_epoch >= epoch) return false;
    const day = new Date(epoch * 1000).toISOString().slice(0, 10);
    if (coin.day !== day) {
      j.db
        .prepare(
          "UPDATE coins SET day=?,opening=reserve,released='0' WHERE mint=?",
        )
        .run(day, mint);
      coin = j.coin(mint);
    }
    const previous = j.db
      .prepare(
        "SELECT epoch,cents FROM volumes WHERE mint=? AND epoch<? ORDER BY epoch DESC LIMIT 8",
      )
      .all(mint, epoch)
      .reverse();
    const consecutive =
      previous.length === 8 &&
      previous.every(
        (r, i) => r.epoch === epoch - (8 - i) * REWARD_POLICY.epochSeconds,
      );
    const released = reserveRelease({
      reserveRaw: coin.reserve,
      openingReserveRaw: coin.opening,
      releasedTodayRaw: coin.released,
      previousVolumes: consecutive ? previous.map((r) => r.cents) : [],
      currentVolume: volume.cents,
    });
    const budget = BigInt(coin.available) + BigInt(released),
      allocation = proportional(budget, snapshot.weights);
    j.db
      .prepare("INSERT INTO volumes(mint,epoch,cents,source) VALUES(?,?,?,?)")
      .run(mint, epoch, volume.cents, volume.source);
    for (const r of allocation.rows) j.credit(mint, r.owner, r.raw);
    j.db
      .prepare(
        "INSERT INTO epochs(mint,epoch,slot,root,budget,released,allocated,proof) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        mint,
        epoch,
        snapshot.slot,
        snapshot.root,
        String(budget),
        released,
        allocation.allocatedRaw,
        JSON.stringify(snapshot),
      );
    j.db
      .prepare(
        "UPDATE coins SET available=?,reserve=?,released=?,last_epoch=? WHERE mint=?",
      )
      .run(
        allocation.carryRaw,
        String(BigInt(coin.reserve) - BigInt(released)),
        String(BigInt(coin.released) + BigInt(released)),
        epoch,
        mint,
      );
    return true;
  });
}
export function obligations(j) {
  let sum = 0n;
  for (const c of j.db.prepare("SELECT available,reserve FROM coins").all())
    sum += BigInt(c.available) + BigInt(c.reserve);
  sum += integerSum(j.db.prepare("SELECT raw FROM credits").all());
  for (const r of j.db
    .prepare(
      "SELECT plan FROM jobs WHERE kind='payout' AND status IN ('pending','review')",
    )
    .all())
    sum += integerSum(JSON.parse(r.plan).rows);
  return sum;
}
export async function observedVolume(mint) {
  try {
    const r = await fetch(
      "https://api.dexscreener.com/latest/dex/tokens/" + mint,
      { signal: AbortSignal.timeout(8000), cache: "no-store" },
    );
    if (!r.ok) throw Error();
    const body = await r.json(),
      pairs = (body.pairs || []).filter(
        (p) =>
          p.chainId === "solana" &&
          p.baseToken?.address === mint &&
          p.quoteToken?.address === NEAR,
      );
    if (!pairs.length) return { cents: null, source: null };
    const ordered = pairs.sort(
        (a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0),
      ),
      p = ordered[0];
    return {
      cents: usdCents(p.volume?.h1),
      source: "https://dexscreener.com/solana/" + p.pairAddress,
    };
  } catch {
    return { cents: null, source: null };
  }
}
export function publicProjection(j, mint, now) {
  const c = j.coin(mint),
    claims = j.db
      .prepare("SELECT * FROM claims WHERE mint=? ORDER BY time DESC LIMIT 30")
      .all(mint),
    payouts = j.db
      .prepare("SELECT * FROM payouts WHERE mint=? ORDER BY time DESC LIMIT 50")
      .all(mint),
    last = j.db
      .prepare(
        "SELECT epoch,slot,root,budget,released,allocated,proof FROM epochs WHERE mint=? ORDER BY epoch DESC LIMIT 1",
      )
      .get(mint),
    allClaims = j.db.prepare("SELECT raw FROM claims WHERE mint=?").all(mint),
    allPayouts = j.db.prepare("SELECT raw FROM payouts WHERE mint=?").all(mint),
    credits = j.db.prepare("SELECT raw FROM credits WHERE mint=?").all(mint);
  return {
    mint,
    treasury: c.treasury,
    policy: REWARD_POLICY,
    policyHash: POLICY_HASH,
    updatedAt: now,
    assetMint: NEAR,
    claimedRaw: String(integerSum(allClaims)),
    distributedRaw: String(integerSum(allPayouts)),
    reserveRaw: c.reserve,
    availableRaw: c.available,
    outstandingRaw: String(integerSum(credits)),
    nextEpoch: epochStart(now) + 900,
    lastSnapshot: last ? { ...last, proof: JSON.parse(last.proof) } : null,
    claims,
    payouts,
    status: j.pending() ? "confirming" : "scheduled",
  };
}
export async function publish(j, now) {
  for (const c of j.db.prepare("SELECT mint FROM coins").all())
    await put(
      "intent-pad-solana-v1/rewards/public/" + c.mint + ".json",
      JSON.stringify(publicProjection(j, c.mint, now)),
      {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
      },
    );
}
export async function tick(
  session,
  rpc,
  key,
  {
    now = Math.floor(Date.now() / 1000),
    coinReader = allReceipts,
    snapshotReader = holderSnapshot,
    volumeReader = observedVolume,
    claimBuilder = prepareClaim,
    payoutBuilder = preparePayout,
    jobReader = finalizedJob,
  } = {},
) {
  const j = session.journal,
    treasury = key.publicKey.toBase58(),
    epoch = epochStart(now);
  let pending = j.pending();
  if (pending) {
    const result = await jobReader(rpc, pending);
    if (result.status === "broadcast") {
      await session.broadcast(rpc, pending);
      return { ready: true, reason: "confirming transaction" };
    }
    if (result.status === "pending")
      return { ready: true, reason: "confirming transaction" };
    settleJob(j, pending, result, now);
    await session.commit();
    if (result.status === "review")
      return {
        ready: false,
        reason: "an expired transaction needs reconciliation",
      };
  }
  if (obligations(j) > (await nearBalance(rpc, treasury)))
    throw Error("Reward liabilities exceed verified treasury funds.");
  const coins = (await coinReader()).filter((c) =>
    registerCoin(j, c, treasury),
  );
  await session.commit();
  for (const coin of coins) {
    let c = j.coin(coin.mint);
    if (c.last_claim < epoch) {
      const prepared = await claimBuilder(rpc, key, coin);
      j.db
        .prepare("UPDATE coins SET last_claim=? WHERE mint=?")
        .run(epoch, coin.mint);
      if (prepared) {
        const job = reserveJob(j, coin.mint, "claim", prepared, now);
        await session.broadcast(rpc, job);
        return { ready: true, reason: "confirming creator-fee claim" };
      }
      await session.commit();
    }
    c = j.coin(coin.mint);
    if (c.last_epoch < epoch) {
      const snapshot = await snapshotReader(rpc, coin.mint, treasury),
        volume = await volumeReader(coin.mint);
      allocateEpoch(j, coin.mint, epoch, snapshot, volume);
      await session.commit();
    }
    c = j.coin(coin.mint);
    {
      const credits = j.db
          .prepare(
            "SELECT owner,raw FROM credits WHERE mint=? AND raw!='0' ORDER BY length(raw) DESC,raw DESC,owner LIMIT 100",
          )
          .all(coin.mint),
        prepared = await payoutBuilder(rpc, key, coin.mint, credits);
      j.db
        .prepare("UPDATE coins SET last_payout=? WHERE mint=?")
        .run(epoch, coin.mint);
      if (prepared) {
        const job = reserveJob(j, coin.mint, "payout", prepared, now);
        await session.broadcast(rpc, job);
        return { ready: true, reason: "confirming holder airdrop" };
      }
      await session.commit();
    }
  }
  await publish(j, now);
  return { ready: true, reason: "ready" };
}
