import {solConversion,walletTokenState,verifyConversionEffects} from '../lib/sol-dev-buy.mjs';
import {rewardReadiness,POLICY_HASH} from '../lib/reward-readiness.mjs';
// PennyFun's reviewed creation/immutable-fee flow, adapted to the verified wNEAR quote.
import { randomUUID, createHash } from "node:crypto";
import BN from "bn.js";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  unpackMint,
  unpackAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  pump,
  launchInstructions,
  verifyFeeAssignment,
  checkNetwork,
} from "../lib/pump-adapter.mjs";
import {
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
import { fail, origin } from "../lib/http.js";
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
  const { creator: user, mint } = input,
    treasury = input.feeTreasury ? new PublicKey(input.feeTreasury) : user;
  const ixs = await launchInstructions({
    creator: user.toBase58(),
    mint: mint.toBase58(),
    treasury: treasury.toBase58(),
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    quote: c.quote,
  });
  if (input.devBuyRaw > 0n) {
    const curve = {
      ...pump.newBondingCurve(
        c.global,
        new PublicKey(NEAR),
        c.quoteControl,
        new BN(input.creatorFeeBps),
      ),
      creator: pump.feeSharingConfigPda(mint),
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
    ixs.push(
      ...(await pump.PUMP_SDK.buyExactQuoteInV3Instructions({
        mint,
        user,
        bondingCurve: curve,
        associatedUserAccountInfo: null,
        quoteAmount: new BN(input.devBuyRaw.toString()),
        amount,
        slippage: 1,
        partialFill: false,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: new PublicKey(c.quote.tokenProgram),
        buybackFeeRecipient: c.global.buybackFeeRecipients.find(
          (k) => !k.equals(PublicKey.default),
        ),
      })),
    );
  }
  const seen = new Set();
  return ixs.filter((ix) => {
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
export async function prepare(raw) {
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
  let conversion=null,tracked=[];
  if(input.devBuySolRaw>0n){
    conversion=await solConversion(creator.toBase58(),input.devBuySolRaw,{mint:mint.toBase58(),treasury:rewards.treasury});
    input.devBuyRaw=BigInt(conversion.minimumRaw);
    tracked=await walletTokenState(rpc,creator.toBase58());
    if(tracked.some(r=>r.state.mint.toBase58()==='So11111111111111111111111111111111111111112'&&r.state.amount>0n))fail('Unwrap existing wrapped SOL before using a SOL initial buy.');
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
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 90000,
  };
  let ixs = await instructions({ ...input, uri,feeTreasury:record.feeTreasury }, c);
  if(conversion)ixs.unshift(...conversion.instructions);
  ixs.push(
    new TransactionInstruction({
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
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
              creatorFeeBps: record.creatorFeeBps,feeTreasury:record.feeTreasury,rewardPolicyHash:POLICY_HASH,
              devBuyRaw: record.devBuyRaw,devBuySolRaw:record.devBuySolRaw,
            }),
          ),
      ),
    }),
  );
  const latest = await rpc.getLatestBlockhashAndContext("confirmed"),
    tx = compileLaunchV1({
      payer: creator,
      latest: latest.value,
      instructions: ixs,
      computeUnitLimit: input.devBuyRaw > 0n ? 1400000 : 700000,
    });
  const before = await rpc.getBalanceAndContext(creator, {
    commitment: "confirmed",
    minContextSlot: latest.context.slot,
  });
  const trackedAddresses=[...new Set([...tracked.map(r=>r.address),getAssociatedTokenAddressSync(new PublicKey(NEAR),creator).toBase58(),getAssociatedTokenAddressSync(mint,creator,false,TOKEN_2022_PROGRAM_ID).toBase58()])];
  const sim = await rpc.simulateTransaction(tx, {
    sigVerify: false,
    commitment: "confirmed",
    minContextSlot: before.context.slot,
    accounts: {
      encoding: "base64",
      addresses: [
        creator.toBase58(),
        pump.feeSharingConfigPda(mint).toBase58(),
        pump.bondingCurvePda(mint).toBase58(),
        ...trackedAddresses,
      ],
    },
  });
  const after = sim.value.accounts?.[0]?.lamports;
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
  if(conversion){
    verifyConversionEffects(tracked,new Map(trackedAddresses.map((a,i)=>[a,sim.value.accounts?.[i+3]])),{creator:record.creator,mint:record.mint,minimumRaw:conversion.minimumRaw});
    const purchased=sim.value.accounts?.[trackedAddresses.indexOf(getAssociatedTokenAddressSync(mint,creator,false,TOKEN_2022_PROGRAM_ID).toBase58())+3];
    if(!purchased||unpackAccount(getAssociatedTokenAddressSync(mint,creator,false,TOKEN_2022_PROGRAM_ID),{...purchased,owner:new PublicKey(purchased.owner),data:Buffer.from(purchased.data[0],"base64")},TOKEN_2022_PROGRAM_ID).amount<=0n)fail("The initial buy did not deliver your launched token.");
    if(BigInt(before.value-after)>input.devBuySolRaw+40000000n)fail("SOL conversion and launch exceed the reviewed cost allowance.");
  }
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
    minContextSlot: sim.context.slot,
  });
  if (fresh.value !== before.value)
    fail("Your balance changed during review. Prepare a fresh transaction.");
  const fee = (await rpc.getFeeForMessage(tx.message, "confirmed")).value;
  if (!Number.isSafeInteger(fee) || fee === null)
    fail("The network fee could not be verified.");
  record.estimatedSolRaw = String(before.value - after + Math.max(500000, fee));
  record.wire = Buffer.from(tx.serialize()).toString("base64");
  record.messageHash = hash(tx.message.serialize());
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
    id,
    mint: record.mint,
    wire: record.wire,
    expiresAt: record.expiresAt,
    lastValidBlockHeight: record.lastValidBlockHeight,
    estimatedSolRaw: record.estimatedSolRaw,
    devBuyRaw: record.devBuyRaw,devBuySolRaw:record.devBuySolRaw,
    creatorFeeBps: record.creatorFeeBps,
    name: record.name,
    symbol: record.symbol,
    quoteMint: NEAR,
    creator: record.creator,feeTreasury:record.feeTreasury,rewardPolicyHash:record.rewardPolicyHash,
  };
}
export async function submit(input) {
  const d = await draft(input.id);
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
export async function status(id, signature, broadcast = false) {
  const d = await draft(id),
    saved = await read("signed/" + id + ".json");
  if (!saved || saved.signature !== signature)
    fail("No matching signed launch is saved.", 404);
  const rpc = connection();
  const existing = await read("receipts/" + d.mint + ".json");
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
    if (sim.value.err !== null)
      fail(
        "The signed launch no longer passes simulation. The original receipt is preserved.",
      );
    const fee = (await rpc.getFeeForMessage(signed.message, "confirmed")).value;
    const after = sim.value.accounts?.[0]?.lamports;
    if (
      !Number.isSafeInteger(after) ||
      sim.context.slot < before.context.slot ||
      after < 0 ||
      after >= before.value ||
      BigInt(before.value - after) > BigInt(d.estimatedSolRaw)
    )
      fail(
        "The signed launch exceeds its reviewed SOL budget. The original receipt is preserved.",
      );
    if (fee === null || fee > 500000)
      fail(
        "The wallet changed the network fee beyond the reviewed limit. Nothing was broadcast.",
      );
    const sent = await rpc.sendRawTransaction(
      Buffer.from(saved.wire, "base64"),
      { skipPreflight: false, maxRetries: 0 },
    );
    if (sent !== signature)
      fail("The RPC returned a mismatched transaction signature.");
  }
  return { status: "submitted", signature, mint: d.mint };
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
