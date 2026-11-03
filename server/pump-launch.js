import {solConversion,walletTokenState,verifyConversionEffects} from '../lib/sol-dev-buy.mjs';
import {compactTokenSetup,assertLaunchTraceBudget,assertTraceCount,innerInstructionCount,blockedLaunchResult} from '../lib/launch-budget.mjs';
import {launchParts,launchMemo,buildBundle,compileBundleTx,ATA_CREATE_TRACE,BUY_TRACE} from '../lib/launch-bundle.mjs';
import {launchLookupTable} from '../lib/lookup-table.mjs';
import {jitoTipAccount,sendJitoBundle,JITO_TIP_LAMPORTS} from '../lib/jito.mjs';
import {rewardReadiness,POLICY_HASH} from '../lib/reward-readiness.mjs';
// PennyFun's reviewed creation/immutable-fee flow, adapted to the verified wNEAR quote.
import { randomUUID, createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  unpackMint,
  unpackAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  pump,
  verifyFeeAssignment,
  checkNetwork,
} from "../lib/pump-adapter.mjs";
import {
  MAX_LAUNCH_BASE64,
  compileLaunchV1,
  decodeLaunchTransaction,
  readLaunchReceipt,
} from "../lib/launch-wire.mjs";
import {
  walletSignedLaunchMatches,
  cloutPaymentSignature,
} from "../lib/launch-signatures.mjs";
import { connection, NEAR } from "../lib/solana-rpc.mjs";
import {
  read,
  create,
  createOnce,
  configured,
  records,
  removePointer,
} from "../lib/store.js";
import { fail, origin, logSimulationFailure, redact } from "../lib/http.js";
import {
  validate,
  publicCoin,
  address as validateBalanceAddress,
} from "../lib/launch-model.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const idOk = (id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
export async function context(fee = 30, rpc = connection()) {
  await checkNetwork(rpc, "mainnet");
  const online = new pump.OnlinePumpSdk(rpc);
  const [global, feeConfig, quoteControl, mintInfo] = await Promise.all([
    online.fetchGlobal(),
    online.fetchFeeConfig(),
    online.fetchQuoteControl(),
    rpc.getAccountInfo(new PublicKey(NEAR), "finalized"),
  ]);
  if (!global.initialized || !global.createV2Enabled)
    fail("Pump.fun creation is currently unavailable.", 503);
  if (!quoteControl?.mints.some((m) => m.mint.toBase58() === NEAR))
    fail("NEAR pairing is not admitted by Pump.fun.", 503);
  if (
    !mintInfo ||
    ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((p) =>
      p.equals(mintInfo.owner),
    )
  )
    fail("The NEAR quote mint is unavailable.", 503);
  const quote = unpackMint(new PublicKey(NEAR), mintInfo, mintInfo.owner);
  if (quote.decimals !== 9)
    fail("The NEAR quote configuration has changed.", 503);
  if (
    !global.creatorFeeConfigurable ||
    BigInt(global.maxConfigurableCreatorFeeBps.toString()) < BigInt(fee)
  )
    fail("The selected creator fee is not enabled by Pump.fun.", 503);
  return {
    global,
    feeConfig,
    quoteControl,
    quote: {
      mint: NEAR,
      tokenProgram: mintInfo.owner.toBase58(),
      creatorFeeBps: fee,
    },
    rpc,
  };
}
export async function instructions(input, c) {
  const { setup, create, fees, buy } = await launchParts(input, c);
  const seen = new Set();
  return [...setup, ...create, ...fees, ...buy].filter((ix) => {
    if (
      ix.programId.toBase58() !== "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    )
      return true;
    const key = ix.keys[1].pubkey.toBase58();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
let cachedHealth;
export async function health() {
  if (cachedHealth && cachedHealth.expires > Date.now())
    return cachedHealth.value;
  const value = healthCheck();
  cachedHealth = { value, expires: Date.now() + 15000 };
  return value;
}
async function healthCheck() {
  const missing = [];
  if (!configured()) missing.push("durable launch storage");
  try {
    await context();
  } catch {
    missing.push("mainnet RPC or NEAR market configuration");
  }
  const rewards=await rewardReadiness();missing.push(...rewards.missing);
  return {
    rewardsReady:rewards.ready,treasury:rewards.treasury,
    ready: !missing.length,
    chain: "solana",
    network: "mainnet",
    quoteMint: NEAR,
    quoteSymbol: "NEAR",
    creatorFeeOptions: [30, 50, 100, 200, 300],
    fundingProvider: "NEAR Intents / 1Click",
    missing,
  };
}
async function draft(id) {
  if (!idOk(id)) fail("Invalid saved launch.");
  const d = await read("drafts/" + id + ".json");
  if (!d) fail("This launch review could not be found.", 404);
  return d;
}
export async function prepare(raw, deps = {}) {
  // Older pages sign a single transaction and cannot sign the bundle review.
  if (raw?.flow !== "bundle") fail("Reload the page to use the updated launch flow.", 409);
  if (!configured())
    fail("Launch storage needs configuration before a wallet approval.", 503);
  const rewards=await rewardReadiness();if(!rewards.ready)fail("Holder rewards need their treasury and worker configured before a launch can lock its fee assignment.",503);
  const input = validate(raw),
    { creator, mint } = input,
    c = await context(input.creatorFeeBps),
    rpc = c.rpc;
  if (await rpc.getAccountInfo(mint, "finalized"))
    fail(
      "This mint already exists. Recover the saved launch before preparing another.",
    );
  const table = await launchLookupTable(rpc),
    tipAccount = await (deps.jitoTipAccount || jitoTipAccount)(),
    tipLamports = JITO_TIP_LAMPORTS;
  let funding=null, route=null, tracked=[];
  if(input.devBuySolRaw>0n){
    if(!raw.fundingId){
      route=await solConversion(creator.toBase58(),input.devBuySolRaw,{mint:mint.toBase58(),treasury:rewards.treasury});
      input.devBuyRaw=BigInt(route.minimumRaw);
      tracked=await walletTokenState(rpc,creator.toBase58(),new Set(route.instructions.flatMap(ix=>ix.keys.map(k=>k.pubkey.toBase58()))));
      if(tracked.some(r=>r.state.mint.toBase58()==='So11111111111111111111111111111111111111112'&&r.state.amount>0n))fail('Unwrap existing wrapped SOL before using a SOL initial buy.');
    } else {
    if(!idOk(raw.fundingId))fail('Invalid saved SOL conversion.');
    funding=await read('funding/'+raw.fundingId+'.json');
    if(!funding||funding.creator!==creator.toBase58()||funding.mint!==mint.toBase58()||funding.devBuySolRaw!==String(input.devBuySolRaw)||funding.feeTreasury!==rewards.treasury)fail('The saved SOL conversion belongs to another wallet, mint, amount or treasury. No second conversion was requested.');
    input.devBuyRaw=BigInt(funding.devBuyRaw);
    const ata=getAssociatedTokenAddressSync(new PublicKey(NEAR),creator),info=await rpc.getAccountInfo(ata,'finalized');
    if(!info||unpackAccount(ata,info,TOKEN_PROGRAM_ID).amount<input.devBuyRaw)fail('The converted NEAR is no longer available in this wallet. No second SOL conversion was requested.');
    }
  }
  const id = randomUUID(),
    site = origin(),
    uri = site + "/api/metadata?id=" + id;
  const record = {
    id,
    creator: creator.toBase58(),
    mint: mint.toBase58(),
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    image: input.image,
    mime: input.mime,
    imageUrl: uri + "&image=1",
    metadataUri: uri,
    website: input.website,
    twitter: input.twitter,
    creatorFeeBps: input.creatorFeeBps,
    devBuyRaw: input.devBuyRaw.toString(),
    devBuySolRaw: input.devBuySolRaw.toString(),
    quoteMint: NEAR,
    feeTreasury:rewards.treasury,rewardPolicyHash:POLICY_HASH,
    phase:"launch",bundle:true,atomicSolBuy:!!route,fundingId:funding?.id||null,fundingSignature:funding?.signature||null,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 90000,
  };
  const parts = await launchParts({ ...input, uri, feeTreasury: record.feeTreasury }, c);
  // New SOL buys never send a standalone swap: the conversion rides in the same atomic bundle.
  // Existing finalized conversions keep their original recovery path and receipt.
  const setup = await compactTokenSetup([...(route?.instructions||[]),...parts.setup],rpc),
    launchSetup = await compactTokenSetup(parts.setup,rpc),
    buy = await compactTokenSetup(parts.buy,rpc),
    memo = launchMemo(id, record);
  const latest = await rpc.getLatestBlockhashAndContext("confirmed"),
    blockhash = latest.value.blockhash;
  const bundle = buildBundle({ payer: creator, mint, blockhash, tables: [table], setup, create: parts.create, fees: parts.fees, buy, memo, tip: { account: tipAccount, lamports: tipLamports }, conversion: !!route });
  const part = (role) => bundle.find((b) => b.role === role)?.tx;
  const before = await rpc.getBalanceAndContext(creator, {
    commitment: "confirmed",
    minContextSlot: latest.context.slot,
  });
  const traces = {};
  let setupDebit = 0n, lastSlot = before.context.slot;
  {
    // Setup (with its memo and any conversion) is independent of creation, so it is simulated
    // exactly as it will be signed.
    const trackedAddresses=route?[...new Set([...tracked.map(r=>r.address),getAssociatedTokenAddressSync(new PublicKey(NEAR),creator).toBase58()])]:[];
    const simA = await rpc.simulateTransaction(part("setup"), {
      sigVerify: false,
      commitment: "confirmed",
      minContextSlot: before.context.slot,
      innerInstructions: true,
      accounts: { encoding: "base64", addresses: [creator.toBase58(), ...trackedAddresses] },
    });
    if (simA.value.err !== null) logSimulationFailure("review", "setup", simA);
    assertLaunchTraceBudget(part("setup"), simA);
    const afterA = simA.value.accounts?.[0]?.lamports;
    if (
      simA.value.err !== null ||
      simA.context.slot < before.context.slot ||
      !Number.isSafeInteger(afterA) ||
      afterA < 0 ||
      afterA >= before.value
    )
      fail("Setup simulation did not pass. Check SOL for the initial buy, rent and network fees. No wallet approval was requested.");
    // Standalone, the conversion must credit at least the buy amount without touching other assets.
    if(route)verifyConversionEffects(tracked,new Map(trackedAddresses.map((a,i)=>[a,simA.value.accounts?.[i+1]])),{creator:creator.toBase58(),mint:mint.toBase58(),minimumRaw:record.devBuyRaw});
    traces.setup = assertTraceCount(part("setup").message.compiledInstructions.length + innerInstructionCount(simA, part("setup").message.compiledInstructions.map((_, i) => i)));
    setupDebit = BigInt(before.value - afterA);
    lastSlot = Math.max(lastSlot, simA.context.slot);
  }
  // Creation and fee assignment need setup's accounts, so setup (without the conversion or memo),
  // createV2 and the two fee-sharing instructions (without the tip or buy) are simulated together
  // for the fee-assignment decode, rent and per-part traces. This combined message is never
  // signed; v1 is used when it does not fit a v0 transaction.
  const combinedIxs = [...launchSetup, ...parts.create, ...parts.fees];
  let combined = compileBundleTx({ payer: creator, blockhash, instructions: combinedIxs, computeUnitLimit: 1400000, tables: [table] }), offset = 2;
  try {
    if (combined.serialize().length > 1232) throw Error();
  } catch {
    combined = compileLaunchV1({ payer: creator, latest: latest.value, instructions: combinedIxs, computeUnitLimit: 1400000 });
    offset = 0;
  }
  const sim = await rpc.simulateTransaction(combined, {
    sigVerify: false,
    commitment: "confirmed",
    minContextSlot: before.context.slot,
    innerInstructions: true,
    accounts: {
      encoding: "base64",
      addresses: [creator.toBase58(),pump.feeSharingConfigPda(mint).toBase58(),pump.bondingCurvePda(mint).toBase58()],
    },
  });
  const after = sim.value.accounts?.[0]?.lamports;
  if (sim.value.err !== null) logSimulationFailure("review", "launch", sim);
  if (JSON.stringify(sim.value.err || "").includes("MaxInstructionTraceLengthExceeded"))
    fail("Coin creation exceeds Solana’s instruction limit. No wallet approval was requested and no SOL was swapped.", 503);
  if (
    sim.value.err !== null ||
    sim.context.slot < before.context.slot ||
    !Number.isSafeInteger(after) ||
    after < 0 ||
    after >= before.value
  )
    fail(
      "Creation simulation did not pass. Check SOL for the initial buy, rent and network fees. No wallet approval was requested.",
    );
  const createStart = offset + launchSetup.length,
    feesStart = createStart + parts.create.length,
    rows = (start, n) => Array.from({ length: n }, (_, i) => start + i),
    buyAtas = buy.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).length;
  // create = createV2 (+ its CPIs) + tip transfer.
  traces.create = assertTraceCount(
    part("create").message.compiledInstructions.length + innerInstructionCount(sim, rows(createStart, parts.create.length)),
  );
  // fees = compute budget + both fee-sharing instructions (+ CPIs) + the unsimulated buy at its
  // measured trace (ATA_CREATE_TRACE per new ATA, BUY_TRACE for the buy).
  traces.fees = assertTraceCount(
    part("fees").message.compiledInstructions.length - buy.length +
      innerInstructionCount(sim, rows(feesStart, parts.fees.length)) +
      buyAtas * ATA_CREATE_TRACE + (buy.length - buyAtas) * BUY_TRACE,
  );
  lastSlot = Math.max(lastSlot, sim.context.slot);
  const sharesAccount = sim.value.accounts?.[1],
    curveAccount = sim.value.accounts?.[2];
  if (!sharesAccount || !curveAccount)
    fail("The launch simulation did not return its fee records.");
  const info = (a) => ({
    ...a,
    data: Buffer.from(a.data[0], "base64"),
    owner: new PublicKey(a.owner),
  });
  const shares = pump.PUMP_SDK.decodeSharingConfig(info(sharesAccount)),
    curve = pump.PUMP_SDK.decodeBondingCurve(info(curveAccount));
  if (
    shares.shareholders.length !== 1 ||
    shares.shareholders[0].address.toBase58() !== record.feeTreasury ||
    shares.shareholders[0].shareBps !== 10000 ||
    pump.isSharingConfigEditable({ sharingConfig: shares }) ||
    curve.quoteMint.toBase58() !== NEAR ||
    curve.creatorFeeBps.toNumber() !== record.creatorFeeBps
  )
    fail("The simulated fee assignment differs from your launch review.");
  const fresh = await rpc.getBalanceAndContext(creator, {
    commitment: "confirmed",
    minContextSlot: lastSlot,
  });
  if (fresh.value !== before.value)
    fail("Your balance changed during review. Prepare a fresh transaction.");
  const fees = await Promise.all(bundle.map(async (b) => (await rpc.getFeeForMessage(b.tx.message, "confirmed")).value));
  if (fees.some((f) => !Number.isSafeInteger(f) || f < 0))
    fail("The network fee could not be verified.");
  const rent165 = await rpc.getMinimumBalanceForRentExemption(165, "confirmed");
  if (!Number.isSafeInteger(rent165) || rent165 <= 0) fail("Account rent could not be verified.", 503);
  const rent = (size) => BigInt(Math.ceil((rent165 * (128 + size)) / 293)),
    ataRent = (ix, t22Size) => (ix.keys[5].pubkey.equals(TOKEN_2022_PROGRAM_ID) ? rent(t22Size) : BigInt(rent165));
  // Both simulations paid setup's ATA rent; the bundle pays it once. The unsimulated buy gets a
  // conservative allowance: its ATAs plus the buyer's Pump volume-accumulator account.
  const overlap = launchSetup.reduce((n, ix) => n + ataRent(ix, 170), 0n),
    buyAllowance = buy.length ? buy.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).reduce((n, ix) => n + ataRent(ix, 200), 0n) + rent(256) : 0n,
    feeTotal = fees.reduce((n, f) => n + f, 0);
  record.estimatedSolRaw = String(setupDebit + BigInt(before.value - after) - overlap + buyAllowance + tipLamports + BigInt(Math.max(500000, feeTotal)));
  record.roles = bundle.map((b) => b.role);
  record.wires = bundle.map((b) => Buffer.from(b.tx.serialize()).toString("base64"));
  record.messageHashes = bundle.map((b) => hash(b.tx.message.serialize()));
  record.instructionCounts = bundle.map((b) => b.tx.message.compiledInstructions.length);
  // The buy cannot run before its mint exists; its construction was checked statically and its
  // trace uses measured constants.
  record.traces = bundle.map((b) => traces[b.role]);
  record.tipLamports = String(tipLamports);
  record.tipAccount = tipAccount;
  record.lookupTable = table.key.toBase58();
  record.lastValidBlockHeight = latest.value.lastValidBlockHeight;
  record.expiresAt =
    Date.now() +
    Math.min(
      60000,
      Math.max(
        0,
        (latest.value.lastValidBlockHeight -
          (await rpc.getBlockHeight("confirmed")) -
          8) *
          400,
      ),
    );
  if (record.expiresAt - Date.now() < 15000)
    fail("This transaction review expired. Retry before approving.");
  await create("drafts/" + id + ".json", record);
  const published = await fetch(uri, {
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  });
  if (
    !published.ok ||
    !published.headers.get("content-type")?.includes("application/json")
  )
    fail(
      "Your coin metadata is not publicly reachable. No wallet approval was requested.",
    );
  const metadata = await published.json();
  if (
    metadata.name !== record.name ||
    metadata.symbol !== record.symbol ||
    metadata.image !== record.imageUrl
  )
    fail("The public metadata differs from the reviewed coin.");
  const publishedImage = await fetch(record.imageUrl, {
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  });
  if (
    !publishedImage.ok ||
    publishedImage.headers.get("content-type") !== record.mime ||
    hash(Buffer.from(await publishedImage.arrayBuffer())) !==
      hash(Buffer.from(record.image.split(",")[1], "base64"))
  )
    fail(
      "The public coin image could not be verified. No wallet approval was requested.",
    );
  return {
    id,phase:"launch",atomicSolBuy:record.atomicSolBuy,fundingId:record.fundingId,
    mint: record.mint,
    bundle: record.roles.map((role, i) => ({ role, wire: record.wires[i] })),
    expiresAt: record.expiresAt,
    lastValidBlockHeight: record.lastValidBlockHeight,
    estimatedSolRaw: record.estimatedSolRaw,
    tipLamports: record.tipLamports,
    devBuyRaw: record.devBuyRaw,devBuySolRaw:record.devBuySolRaw,
    creatorFeeBps: record.creatorFeeBps,
    name: record.name,
    symbol: record.symbol,
    quoteMint: NEAR,
    creator: record.creator,feeTreasury:record.feeTreasury,rewardPolicyHash:record.rewardPolicyHash,
  };
}
export function verifyConversionReceipt(tx,d){
 const keys=tx.transaction.message.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses}),ata=getAssociatedTokenAddressSync(new PublicKey(NEAR),new PublicKey(d.creator)).toBase58();let received=0n;const before=new Map((tx.meta.preTokenBalances||[]).map(r=>[r.accountIndex,r])),after=new Map((tx.meta.postTokenBalances||[]).map(r=>[r.accountIndex,r]));for(const index of new Set([...before.keys(),...after.keys()])){const a=before.get(index),b=after.get(index);if(a?.owner!==d.creator&&b?.owner!==d.creator)continue;if(a&&b&&(a.owner!==b.owner||a.mint!==b.mint||a.programId!==b.programId))fail('Conversion receipt changed token ownership.');const delta=BigInt(b?.uiTokenAmount.amount||'0')-BigInt(a?.uiTokenAmount.amount||'0');if(keys.get(index)?.toBase58()===ata){if(b?.mint!==NEAR||b.owner!==d.creator||b.programId!==TOKEN_PROGRAM_ID.toBase58())fail('Conversion receipt has an invalid destination.');received+=delta;}else if(a?.mint!=='So11111111111111111111111111111111111111112'&&delta<0n)fail('Conversion receipt consumed another wallet token.');}
 if(received<BigInt(d.devBuyRaw)||keys.get(0)?.toBase58()!==d.creator||BigInt(tx.meta.preBalances[0]-tx.meta.postBalances[0])>BigInt(d.estimatedSolRaw))fail('Conversion receipt did not deliver its reviewed minimum.');return String(received);
}
export async function submit(input, deps = {}) {
  const d = await draft(input.id);
  if (!d.bundle) return legacySubmit(d, input);
  if (!Array.isArray(input.wires))
    fail("Reload the page to use the updated launch flow.", 409);
  if (
    input.wires.length !== d.wires.length ||
    input.wires.some((w) => typeof w !== "string" || !w || w.length > MAX_LAUNCH_BASE64)
  )
    fail("The signed launch bundle is invalid.");
  const signatures = input.wires.map((wire, i) => {
    try {
      const bytes = Buffer.from(wire, "base64");
      walletSignedLaunchMatches(Buffer.from(d.wires[i], "base64"), bytes);
      return cloutPaymentSignature(bytes);
    } catch {
      return fail(
        "The wallet returned an altered or incomplete transaction. Nothing was submitted.",
      );
    }
  });
  // Coin creation's signature identifies the launch, as the single transaction's did.
  const signature = signatures[d.roles.indexOf("create")],
    same = (a, b) => a.signature === b.signature && a.signatures?.join() === b.signatures?.join();
  const saved = await read("signed/" + d.id + ".json");
  if (saved) {
    if (!same(saved, { signature, signatures }))
      fail(
        "A different transaction is already saved. Check the original receipt.",
      );
    await indexPending(saved);
    return status(d.id, signature, true, deps);
  }
  if (Date.now() > d.expiresAt)
    fail("This review expired. No signed transaction was submitted.");
  // Persist before anything is sent: a resend only ever uses these exact bytes.
  const signed = await createOnce(
    "signed/" + d.id + ".json",
    { id: d.id, bundle: true, signature, signatures, roles: d.roles, wires: input.wires, createdAt: Date.now() },
    same,
  );
  await indexPending(signed);
  return status(d.id, signature, true, deps);
}
export async function status(id, signature, broadcast = false, deps = {}) {
  const d = await draft(id),
    saved = await read("signed/" + id + ".json");
  if (!saved || saved.signature !== signature)
    fail("No matching signed launch is saved.", 404);
  if (d.bundle) return bundleStatus(d, saved, broadcast, deps);
  return legacyStatus(d, saved, signature, broadcast);
}
export const RESEND_MS = 2000;
const lastSends = new Map();
const TRACE_BLOCKED = "The signed launch exceeds Solana’s instruction limit after wallet security checks. Submission was blocked; your original receipt is preserved.";
function bundleIo(deps) {
  return {
    rpc: deps.rpc || connection(),
    read: deps.read || read,
    create: deps.create || create,
    createOnce: deps.createOnce || createOnce,
    removePointer: deps.removePointer || removePointer,
    sendBundle: deps.sendJitoBundle || sendJitoBundle,
    now: deps.now || Date.now,
  };
}
/**
 * Bundle outcome from chain state only. Height is read before signatures so "none seen" past
 * lastValidBlockHeight proves nothing can still land. Terminal answers need finalized rows.
 */
export async function bundleStatus(d, saved, broadcast = false, deps = {}) {
  const io = bundleIo(deps),
    { signature } = saved,
    mint = d.mint,
    unpend = async () => {
      try {
        await io.removePointer(pendingKey(saved));
      } catch {
        /* The signed outbox and outcome records remain; cleanup retries on the next read. */
      }
    };
  const existing = await io.read("receipts/" + d.mint + ".json");
  if (existing) {
    if (existing.signature !== signature)
      fail("The mint has another confirmed launch record.");
    await unpend();
    return { status: "confirmed", coin: publicCoin(existing) };
  }
  const recorded = await io.read("partials/" + d.id + ".json");
  if (recorded) {
    if (recorded.signature !== signature) fail("The launch has another recorded outcome.");
    await unpend();
    return partialResult(d, recorded);
  }
  const slot = await io.rpc.getSlot("finalized"),
    height = await io.rpc.getBlockHeight({ commitment: "finalized", minContextSlot: slot }),
    found = await io.rpc.getSignatureStatuses(saved.signatures, { searchTransactionHistory: true });
  const rows = found?.value;
  if (!(found?.context?.slot >= slot) || !Array.isArray(rows) || rows.length !== saved.signatures.length)
    return { status: "checking", signature, mint };
  const create = saved.roles.indexOf("create"),
    past = height > d.lastValidBlockHeight,
    final = (r) => r?.confirmationStatus === "finalized";
  if (rows[create]?.err && final(rows[create])) {
    await unpend();
    return {
      status: "failed",
      signature,
      mint,
      error: "Coin creation failed onchain, so no coin was created. Any converted NEAR stays in your wallet.",
    };
  }
  if (rows.every((r) => r && r.err === null && final(r))) return confirmBundle(d, saved, io, unpend);
  if (rows.some(Boolean)) {
    // Part of the bundle is visible. Bundles are all-or-nothing, so a settled mix means a
    // transaction landed outside its bundle: record it, never re-sign, reconcile by hand.
    if (rows.every((r) => (r ? final(r) : past))) {
      const outcome = await io.createOnce(
        "partials/" + d.id + ".json",
        {
          id: d.id,
          signature,
          signatures: saved.signatures,
          roles: saved.roles,
          states: rows.map((r) => (!r ? "missing" : r.err ? "failed" : "landed")),
          created: rows[create]?.err === null,
          recordedAt: io.now(),
        },
        (a, b) => a.signature === b.signature,
      );
      await unpend();
      return partialResult(d, outcome);
    }
    return { status: "confirming", signature, mint };
  }
  if (past) {
    await unpend();
    return {
      status: "expired",
      signature,
      mint,
      error: "Expired before landing, so nothing was charged. Start a new launch to retry.",
    };
  }
  const attempted = await io.read("broadcasts/" + d.id + ".json");
  if (!attempted) {
    if (!broadcast) {
      const rejected = await io.read("submission-checks/" + d.id + ".json");
      if (rejected?.signature === signature) return blockedLaunchResult(d, signature, rejected.error);
      return { status: "checking", signature, mint };
    }
    const blocked = await preflightBundle(d, saved, io);
    if (blocked) return recordBlocked(d, saved, blocked, io.createOnce);
    await io.createOnce(
      "broadcasts/" + d.id + ".json",
      { id: d.id, signature, attemptedAt: io.now() },
      (a, b) => a.signature === b.signature,
    );
  }
  return resendBundle(d, saved, io);
}
// A partial launch is never published: a coin created without its fee transaction has no locked
// fee assignment and needs manual reconciliation.
function partialResult(d, outcome) {
  const fees = outcome.states?.[outcome.roles?.indexOf("fees")];
  return {
    status: "partial",
    signature: outcome.signature,
    signatures: outcome.signatures,
    mint: d.mint,
    created: outcome.created === true,
    feesLanded: fees === "landed",
    error: !outcome.created
      ? "Part of the launch landed without coin creation. No coin was created; converted NEAR stays in your wallet."
      : fees !== "landed"
        ? "Your coin was created without its fee setup, so it is not listed. Keep this receipt; nothing will be re-signed."
        : "Your coin was created, but part of the launch did not land. Keep this receipt; nothing will be re-signed.",
  };
}
// Checks the signed bytes before the first send. Only the first bundle transaction can run
// alone; the others are protected by bundle atomicity and their exact reviewed construction.
async function preflightBundle(d, saved, io) {
  const txs = saved.wires.map((w) => decodeLaunchTransaction(Buffer.from(w, "base64")));
  for (let i = 0; i < txs.length; i++) {
    const added = txs[i].message.compiledInstructions.length - d.instructionCounts[i];
    if (!Number.isSafeInteger(d.traces?.[i]) || d.traces[i] + added > 64) return TRACE_BLOCKED;
    const fee = (await io.rpc.getFeeForMessage(txs[i].message, "confirmed")).value;
    if (!Number.isSafeInteger(fee) || fee > 500000)
      return "The wallet changed the network fee beyond the reviewed limit. Nothing was broadcast.";
  }
  const before = await io.rpc.getBalanceAndContext(new PublicKey(d.creator), "confirmed");
  const sim = await io.rpc.simulateTransaction(txs[0], {
    sigVerify: true,
    commitment: "confirmed",
    minContextSlot: before.context.slot,
    accounts: { encoding: "base64", addresses: [d.creator] },
  });
  if (sim.value.err !== null) {
    logSimulationFailure("submit", saved.roles[0], sim);
    return JSON.stringify(sim.value.err).includes("MaxInstructionTraceLengthExceeded")
      ? TRACE_BLOCKED
      : "The signed launch no longer passes simulation. Submission was blocked; your original receipt is preserved.";
  }
  const after = sim.value.accounts?.[0]?.lamports;
  if (
    !Number.isSafeInteger(after) ||
    sim.context.slot < before.context.slot ||
    after < 0 ||
    after >= before.value ||
    BigInt(before.value - after) > BigInt(d.estimatedSolRaw)
  )
    return "The signed launch exceeds its reviewed SOL budget. The original receipt is preserved.";
  return null;
}
// Resends the identical signed bundle at most once per RESEND_MS per draft, across instances:
// a create-only claim per time window plus the previous window's claim time.
async function resendBundle(d, saved, io) {
  const now = io.now(),
    bucket = Math.floor(now / RESEND_MS),
    result = { status: "submitted", signature: saved.signature, mint: d.mint },
    last = lastSends.get(d.id);
  if (last !== undefined && now - last < RESEND_MS) return result;
  const prior = await io.read("jito/" + d.id + "-" + (bucket - 1) + ".json");
  if (prior && now - prior.claimedAt < RESEND_MS) return result;
  try {
    await io.create("jito/" + d.id + "-" + bucket + ".json", { id: d.id, signature: saved.signature, claimedAt: now });
  } catch {
    return result;
  }
  if (lastSends.size > 1000) lastSends.clear();
  lastSends.set(d.id, now);
  try {
    const bundleId = await io.sendBundle(saved.wires);
    try {
      await io.create("jito/" + d.id + "-" + bucket + "-sent.json", { id: d.id, bundleId, sentAt: io.now() });
    } catch {
      /* The bundle id is diagnostic only; signatures remain the source of truth. */
    }
    return { ...result, bundleId };
  } catch (error) {
    // Rate limits and engine rejections are not failures: identical bytes are resent until
    // the blockhash expires, and a bundle that never lands charges nothing.
    console.error(
      JSON.stringify({
        service: "intent-pad-api",
        jitoSend: error?.retryable ? "retryable" : "rejected",
        id: d.id,
        detail: redact(error?.detail || error?.message),
      }),
    );
    return result;
  }
}
async function confirmBundle(d, saved, io, unpend) {
  const txs = await Promise.all(saved.signatures.map((s) => readLaunchReceipt(io.rpc, s)));
  txs.forEach((tx, i) => {
    if (!tx?.meta || tx.meta.err !== null)
      fail("Finalized receipt indexing is delayed. Keep this signature.");
    const approved = Buffer.from(decodeLaunchTransaction(Buffer.from(saved.wires[i], "base64")).message.serialize());
    if (!approved.equals(Buffer.from(tx.transaction.message.serialize())))
      fail("The finalized receipt differs from the approved launch.");
  });
  await verifyFeeAssignment(io.rpc, d.mint, d.feeTreasury||d.creator, NEAR, d.creatorFeeBps);
  const mint = await io.rpc.getAccountInfo(new PublicKey(d.mint), "finalized");
  if (!mint || !mint.owner.equals(TOKEN_2022_PROGRAM_ID))
    fail("The launched token mint could not be verified.");
  const state = unpackMint(new PublicKey(d.mint), mint, TOKEN_2022_PROGRAM_ID);
  if (state.decimals !== 6 || state.freezeAuthority !== null)
    fail("The launched mint differs from the supported token standard.");
  const receipt = (role) => txs[saved.roles.indexOf(role)] || fail("The launch receipt is missing a reviewed transaction.");
  if (d.atomicSolBuy) verifyConversionReceipt(receipt("setup"), d);
  if (BigInt(d.devBuyRaw) > 0n) verifyBuyReceipt(receipt("fees"), d);
  const coin = {
    ...d,
    signature: saved.signature,
    signatures: saved.signatures,
    verifiedAt: new Date().toISOString(),
    supply: state.supply.toString(),
    decimals: state.decimals,
  };
  delete coin.wire;
  delete coin.wires;
  delete coin.image;
  await io.createOnce(
    "receipts/" + d.mint + ".json",
    coin,
    (a, b) => a.signature === b.signature,
  );
  await unpend();
  return { status: "confirmed", coin: publicCoin(coin) };
}
// The bundle buy may spend at most the reviewed NEAR and must credit the new mint to the
// launching wallet's canonical Token-2022 account; no other wallet token may decrease.
export function verifyBuyReceipt(tx, d) {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }),
    ata = getAssociatedTokenAddressSync(new PublicKey(d.mint), new PublicKey(d.creator), false, TOKEN_2022_PROGRAM_ID).toBase58(),
    near = getAssociatedTokenAddressSync(new PublicKey(NEAR), new PublicKey(d.creator)).toBase58();
  if (keys.get(0)?.toBase58() !== d.creator) fail("The initial buy receipt has another fee payer.");
  const before = new Map((tx.meta.preTokenBalances || []).map((r) => [r.accountIndex, r])),
    after = new Map((tx.meta.postTokenBalances || []).map((r) => [r.accountIndex, r]));
  let bought = 0n;
  for (const index of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(index), b = after.get(index);
    if (a?.owner !== d.creator && b?.owner !== d.creator) continue;
    if (a && b && (a.owner !== b.owner || a.mint !== b.mint || a.programId !== b.programId))
      fail("The initial buy receipt changed token ownership.");
    const delta = BigInt(b?.uiTokenAmount.amount || "0") - BigInt(a?.uiTokenAmount.amount || "0"),
      key = keys.get(index)?.toBase58();
    if (key === ata) {
      if (b?.mint !== d.mint || b.owner !== d.creator || b.programId !== TOKEN_2022_PROGRAM_ID.toBase58())
        fail("The initial buy receipt has an invalid destination.");
      bought += delta;
    } else if (key === near) {
      if (delta < -BigInt(d.devBuyRaw)) fail("The initial buy spent more NEAR than reviewed.");
    } else if (delta < 0n) fail("The initial buy consumed another wallet token.");
  }
  if (bought <= 0n)
    fail("The initial buy receipt did not credit the launching wallet.");
  return String(bought);
}
// Single-transaction drafts saved before bundles keep their original submission path.
async function legacySubmit(d, input) {
  if (typeof input.wire !== "string" || input.wire.length > 5500)
    fail("The signed transaction is invalid.");
  const bytes = Buffer.from(input.wire, "base64");
  try {
    walletSignedLaunchMatches(Buffer.from(d.wire, "base64"), bytes);
  } catch {
    fail(
      "The wallet returned an altered or incomplete transaction. Nothing was submitted.",
    );
  }
  const signature = cloutPaymentSignature(bytes);
  const saved = await read("signed/" + d.id + ".json");
  if (saved) {
    if (saved.signature !== signature)
      fail(
        "A different transaction is already saved. Check the original receipt.",
      );
    await indexPending(saved);
    return status(d.id, signature, true);
  }
  if (Date.now() > d.expiresAt)
    fail("This review expired. No signed transaction was submitted.");
  const signed = await createOnce(
    "signed/" + d.id + ".json",
    { id: d.id, signature, wire: input.wire, createdAt: Date.now() },
    (a, b) => a.signature === b.signature,
  );
  await indexPending(signed);
  return status(d.id, signature, true);
}
// Single-transaction and standalone-conversion drafts keep their original recovery path.
async function legacyStatus(d, saved, signature, broadcast) {
  const id = d.id, rpc = connection();
  if(d.phase==='conversion'){const funded=await read('funding/'+d.id+'.json');if(funded){if(funded.signature!==signature)fail('The conversion has another confirmed receipt.');await removePending(saved);return {status:'converted',funding:{id:d.id,signature,nearRaw:funded.receivedRaw}};}}
  const existing = d.phase==='conversion'?null:await read("receipts/" + d.mint + ".json");
  if (existing) {
    if (existing.signature !== signature)
      fail("The mint has another confirmed launch record.");
    await removePending(saved);
    return { status: "confirmed", coin: publicCoin(existing) };
  }
  const chain = (
    await rpc.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
  if (chain?.err) {
    await removePending(saved);
    return {
      status: "failed",
      signature,
      mint: d.mint,
      error:
        "The onchain transaction failed. Review the original receipt before retrying.",
    };
  }
  if (chain?.confirmationStatus === "finalized") {
    const tx = await readLaunchReceipt(rpc, signature);
    if (!tx?.meta || tx.meta.err !== null)
      fail("Finalized receipt indexing is delayed. Keep this signature.");
    const recordTx = decodeLaunchTransaction(Buffer.from(saved.wire, "base64"));
    if (
      !tx.transaction.message
        .serialize()
        .every((v, i) => v === recordTx.message.serialize()[i]) ||
      tx.transaction.message.serialize().length !==
        recordTx.message.serialize().length
    )
      fail("The finalized receipt differs from the approved launch.");
    if(d.phase==='conversion'){
      const receivedRaw=verifyConversionReceipt(tx,d),funded={id:d.id,creator:d.creator,mint:d.mint,devBuySolRaw:d.devBuySolRaw,devBuyRaw:d.devBuyRaw,receivedRaw,feeTreasury:d.feeTreasury,signature,verifiedAt:new Date().toISOString()};await createOnce('funding/'+d.id+'.json',funded,(a,b)=>a.signature===b.signature);await removePending(saved);return {status:'converted',funding:{id:d.id,signature,nearRaw:receivedRaw}};
    }
    await verifyFeeAssignment(rpc, d.mint, d.feeTreasury||d.creator, NEAR, d.creatorFeeBps);
    const mint = await rpc.getAccountInfo(new PublicKey(d.mint), "finalized");
    if (!mint || !mint.owner.equals(TOKEN_2022_PROGRAM_ID))
      fail("The launched token mint could not be verified.");
    const state = unpackMint(
      new PublicKey(d.mint),
      mint,
      TOKEN_2022_PROGRAM_ID,
    );
    if (state.decimals !== 6 || state.freezeAuthority !== null)
      fail("The launched mint differs from the supported token standard.");
    if(d.atomicSolBuy)verifyAtomicLaunchReceipt(tx,d);
    const coin = {
      ...d,
      signature,
      verifiedAt: new Date().toISOString(),
      supply: state.supply.toString(),
      decimals: state.decimals,
    };
    delete coin.wire;
    delete coin.image;
    await createOnce(
      "receipts/" + d.mint + ".json",
      coin,
      (a, b) => a.signature === b.signature,
    );
    await removePending(saved);
    return { status: "confirmed", coin: publicCoin(coin) };
  }
  if (chain) return { status: "confirming", signature, mint: d.mint };
  if ((await rpc.getBlockHeight("finalized")) > d.lastValidBlockHeight) {
    await removePending(saved);
    return {
      status: "review",
      signature,
      mint: d.mint,
      error:
        "The transaction is expired or uncertain. Keep the original signature for reconciliation; no second payment was requested.",
    };
  }
  if(!broadcast){
    const [rejected,attempted]=await Promise.all([read('submission-checks/'+id+'.json'),read('broadcasts/'+id+'.json')]);
    if(rejected?.signature===signature&&!attempted)return blockedLaunchResult(d,signature,rejected.error);
    return {status:'checking',signature,mint:d.mint};
  }
  if (broadcast) {
    const signed = decodeLaunchTransaction(Buffer.from(saved.wire, "base64"));
    const before = await rpc.getBalanceAndContext(
      new PublicKey(d.creator),
      "confirmed",
    );
    const sim = await rpc.simulateTransaction(signed, {
      sigVerify: true,
      commitment: "confirmed",
      minContextSlot: before.context.slot,
      accounts: { encoding: "base64", addresses: [d.creator] },
    });
    if (sim.value.err !== null) logSimulationFailure("submit", d.phase, sim);
    if (sim.value.err !== null)
      return recordBlocked(d,saved,JSON.stringify(sim.value.err).includes('MaxInstructionTraceLengthExceeded')
        ?'The signed transaction exceeds Solana’s instruction limit after wallet security checks. Submission was blocked; your original receipt is preserved.'
        :'The signed launch no longer passes simulation. Submission was blocked; your original receipt is preserved.');
    const fee = (await rpc.getFeeForMessage(signed.message, "confirmed")).value;
    const after = sim.value.accounts?.[0]?.lamports;
    if (
      !Number.isSafeInteger(after) ||
      sim.context.slot < before.context.slot ||
      after < 0 ||
      after >= before.value ||
      BigInt(before.value - after) > BigInt(d.estimatedSolRaw)
    )
      return recordBlocked(d,saved,
        "The signed launch exceeds its reviewed SOL budget. The original receipt is preserved.",
      );
    if (fee === null || fee > 500000)
      return recordBlocked(d,saved,
        "The wallet changed the network fee beyond the reviewed limit. Nothing was broadcast.",
      );
    await createOnce('broadcasts/'+id+'.json',{id,signature,attemptedAt:Date.now()},(a,b)=>a.signature===b.signature);
    const sent = await rpc.sendRawTransaction(
      Buffer.from(saved.wire, "base64"),
      { skipPreflight: false, maxRetries: 0 },
    );
    if (sent !== signature)
      fail("The RPC returned a mismatched transaction signature.");
  }
  return { status: "submitted", signature, mint: d.mint };
}
async function recordBlocked(d,saved,error,save=createOnce){
  await save('submission-checks/'+d.id+'.json',{id:d.id,signature:saved.signature,error,checkedAt:Date.now()},(a,b)=>a.signature===b.signature);
  return blockedLaunchResult(d,saved.signature,error);
}
export function verifyAtomicLaunchReceipt(tx,d){
  // The exact signed message has already been verified. Its swap must not
  // consume pre-existing NEAR or another wallet token, and its buy must credit
  // the new mint to the launching wallet's canonical Token-2022 account.
  verifyConversionReceipt(tx,{...d,devBuyRaw:'0'});
  const keys=tx.transaction.message.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses});
  const ata=getAssociatedTokenAddressSync(new PublicKey(d.mint),new PublicKey(d.creator),false,TOKEN_2022_PROGRAM_ID).toBase58();
  const bought=(tx.meta.postTokenBalances||[]).find(r=>keys.get(r.accountIndex)?.toBase58()===ata);
  if(!bought||bought.mint!==d.mint||bought.owner!==d.creator||bought.programId!==TOKEN_2022_PROGRAM_ID.toBase58()||BigInt(bought.uiTokenAmount.amount)<=0n)
    fail('The atomic launch receipt did not credit its initial buy to the launching wallet.');
}
export async function walletBalance(value) {
  const user = validateBalanceAddress(value),
    rpc = connection();
  await checkNetwork(rpc, "mainnet");
  const ata = getAssociatedTokenAddressSync(
    new PublicKey(NEAR),
    user,
    false,
    TOKEN_PROGRAM_ID,
  );
  const [sol, token] = await Promise.all([
    rpc.getBalance(user, "finalized"),
    rpc.getAccountInfo(ata, "finalized"),
  ]);
  return {
    solRaw: String(sol),
    nearRaw: token
      ? unpackAccount(ata, token, TOKEN_PROGRAM_ID).amount.toString()
      : "0",
  };
}
function pendingKey(saved) {
  return (
    "pending/" +
    String(9999999999999 - (saved.createdAt || 0)).padStart(13, "0") +
    "-" +
    saved.id +
    ".json"
  );
}
async function indexPending(saved) {
  await createOnce(
    pendingKey(saved),
    { id: saved.id, signature: saved.signature },
    (a, b) => a.signature === b.signature,
  );
}
async function removePending(saved) {
  try {
    await removePointer(pendingKey(saved));
  } catch {
    /* The immutable signed outbox and receipt remain intact; retry the pointer cleanup on the next read. */
  }
}
let reconciliation;
async function reconcilePending() {
  if (reconciliation && reconciliation.until > Date.now())
    return reconciliation.work;
  const work = (async () => {
    const pending = await records("pending/", 5);
    await Promise.allSettled(
      pending.map((p) => status(p.id, p.signature, false)),
    );
  })();
  reconciliation = { work, until: Date.now() + 15000 };
  return work;
}
export async function listCoins() {
  await reconcilePending();
  return (await records("receipts/"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicCoin);
}
