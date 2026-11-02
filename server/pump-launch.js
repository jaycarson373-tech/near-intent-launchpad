import {solConversion,walletTokenState,verifyConversionEffects} from '../lib/sol-dev-buy.mjs';
import {blockedLaunchResult} from '../lib/launch-budget.mjs';
import {buildLaunchBundle,simulateLaunchBundle,tipAccount,verifySignedBundle,jitoRequest,messageMatchesReceipt,bundleProgress} from '../lib/launch-bundle.mjs';
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
import { fail, origin, logSimulationFailure } from "../lib/http.js";
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
    phase:"launch",atomicSolBuy:!!route,fundingId:funding?.id||null,fundingSignature:funding?.signature||null,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 90000,
  };
  let ixs = await instructions({ ...input, uri,feeTreasury:record.feeTreasury }, c);
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
  const latest=await rpc.getLatestBlockhashAndContext('confirmed');
  const bundle=await buildLaunchBundle({rpc,payer:creator,mint,launch:ixs,route:route?.instructions||[],latest:latest.value,tip:await tipAccount()});
  const nearAta=getAssociatedTokenAddressSync(new PublicKey(NEAR),creator).toBase58();
  const boughtAta=getAssociatedTokenAddressSync(mint,creator,false,TOKEN_2022_PROGRAM_ID).toBase58();
  record.bundle=true;record.wires=bundle.wires;record.creationIndex=bundle.creationIndex;
  record.tradeIndex=input.devBuyRaw>0n?bundle.wires.length-1:null;
  record.tipLamports=bundle.tipLamports;
  record.simulationAddresses=[...new Set([creator.toBase58(),pump.feeSharingConfigPda(mint).toBase58(),pump.bondingCurvePda(mint).toBase58(),nearAta,boughtAta,...tracked.map(r=>r.address)])];
  // Prove per-transaction space for wallet security checks, then simulate the
  // exact reviewed messages sequentially against the same real mainnet bank.
  await simulateLaunchBundle(rpc,bundle.capacityWires,record.simulationAddresses);
  const sim=await simulateLaunchBundle(rpc,bundle.wires,record.simulationAddresses);
  const debit=verifyBundleSimulation(record,sim);
  const newSolInput=record.atomicSolBuy?input.devBuySolRaw:0n;
  if(debit<newSolInput||debit>newSolInput+50000000n)
    fail('The combined launch exceeds its bounded SOL purchase and creation budget. No payment was requested.');
  const fresh=await rpc.getBalanceAndContext(creator,{commitment:'confirmed',minContextSlot:sim.slot});
  if(fresh.value!==sim.before[0].lamports)fail('Your balance changed during review. Prepare a fresh launch.');
  record.estimatedSolRaw=String(debit+500000n);
  record.wire=bundle.wires[bundle.creationIndex];
  record.lastValidBlockHeight=latest.value.lastValidBlockHeight;
  record.expiresAt=Date.now()+Math.min(60000,Math.max(0,(latest.value.lastValidBlockHeight-(await rpc.getBlockHeight('confirmed'))-8)*400));
  if(record.expiresAt-Date.now()<15000)fail('This launch review expired before approval. Prepare again.');
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
    bundle:true,wires:record.wires,creationIndex:record.creationIndex,tipLamports:record.tipLamports,
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
export function verifyConversionReceipt(tx,d){
 const keys=tx.transaction.message.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses}),ata=getAssociatedTokenAddressSync(new PublicKey(NEAR),new PublicKey(d.creator)).toBase58();let received=0n;const before=new Map((tx.meta.preTokenBalances||[]).map(r=>[r.accountIndex,r])),after=new Map((tx.meta.postTokenBalances||[]).map(r=>[r.accountIndex,r]));for(const index of new Set([...before.keys(),...after.keys()])){const a=before.get(index),b=after.get(index);if(a?.owner!==d.creator&&b?.owner!==d.creator)continue;if(a&&b&&(a.owner!==b.owner||a.mint!==b.mint||a.programId!==b.programId))fail('Conversion receipt changed token ownership.');const delta=BigInt(b?.uiTokenAmount.amount||'0')-BigInt(a?.uiTokenAmount.amount||'0');if(keys.get(index)?.toBase58()===ata){if(b?.mint!==NEAR||b.owner!==d.creator||b.programId!==TOKEN_PROGRAM_ID.toBase58())fail('Conversion receipt has an invalid destination.');received+=delta;}else if(a?.mint!=='So11111111111111111111111111111111111111112'&&delta<0n)fail('Conversion receipt consumed another wallet token.');}
 if(received<BigInt(d.devBuyRaw)||keys.get(0)?.toBase58()!==d.creator||BigInt(tx.meta.preBalances[0]-tx.meta.postBalances[0])>BigInt(d.estimatedSolRaw))fail('Conversion receipt did not deliver its reviewed minimum.');return String(received);
}
function decodedAccount(a){
  if(!a||!Array.isArray(a.data)||a.data[1]!=='base64')fail('The bundle account data could not be verified.',503);
  return {...a,owner:new PublicKey(a.owner),data:Buffer.from(a.data[0],'base64')};
}
export function verifyBundleSimulation(d,sim){
  const initial=sim.before[0]?.lamports,final=sim.after[0]?.lamports;
  if(!Number.isSafeInteger(initial)||!Number.isSafeInteger(final)||final<0||final>=initial)
    fail('The bundle SOL debit could not be verified.',503);
  const sharesAccount=decodedAccount(sim.after[1]),curveAccount=decodedAccount(sim.after[2]);
  if(!sharesAccount.owner.equals(pump.PUMP_FEE_PROGRAM_ID)||!curveAccount.owner.equals(pump.PUMP_PROGRAM_ID))fail('The simulated fee records have an unexpected program owner.');
  const shares=pump.PUMP_SDK.decodeSharingConfig(sharesAccount);
  const curve=pump.PUMP_SDK.decodeBondingCurve(curveAccount);
  if(shares.mint.toBase58()!==d.mint||shares.shareholders.length!==1||shares.shareholders[0].address.toBase58()!==d.feeTreasury||shares.shareholders[0].shareBps!==10000||pump.isSharingConfigEditable({sharingConfig:shares})||curve.quoteMint.toBase58()!==NEAR||curve.creatorFeeBps.toNumber()!==d.creatorFeeBps||curve.creator.toBase58()!==pump.feeSharingConfigPda(new PublicKey(d.mint)).toBase58())
    fail('The bundle fee assignment differs from the launch review.');
  if(BigInt(d.devBuyRaw)>0n){
    const purchased=unpackAccount(new PublicKey(d.simulationAddresses[4]),decodedAccount(sim.after[4]),TOKEN_2022_PROGRAM_ID);
    if(purchased.amount<=0n||purchased.owner.toBase58()!==d.creator||purchased.mint.toBase58()!==d.mint)fail('The bundle did not deliver its initial buy.');
  }
  if(d.atomicSolBuy){
    const rows=[];
    for(let i=3;i<d.simulationAddresses.length;i++){
      const a=sim.before[i];if(!a||![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(a.owner))continue;
      const account=decodedAccount(a),address=new PublicKey(d.simulationAddresses[i]);
      const state=unpackAccount(address,account,account.owner);
      if(state.owner.toBase58()===d.creator)rows.push({address:address.toBase58(),program:account.owner,state});
    }
    verifyConversionEffects(rows,new Map(d.simulationAddresses.map((a,i)=>[a,sim.after[i]])),{creator:d.creator,mint:d.mint,minimumRaw:'0',atomicBuy:true});
  }
  return BigInt(initial-final);
}
export async function submit(input) {
  const d = await draft(input.id);
  if(d.bundle){
    const approved=verifySignedBundle(d,input.wires);
    const prior=await read('signed/'+d.id+'.json');
    if(!prior&&Date.now()>d.expiresAt)fail('This launch review expired. Nothing was submitted.');
    const saved=await createOnce('signed/'+d.id+'.json',{id:d.id,...approved,createdAt:Date.now()},(a,b)=>a.signatures?.join()===b.signatures.join());
    await indexPending(saved);return status(d.id,saved.signature,true);
  }
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
  if(d.phase==='conversion'){const funded=await read('funding/'+d.id+'.json');if(funded){if(funded.signature!==signature)fail('The conversion has another confirmed receipt.');await removePending(saved);return {status:'converted',funding:{id:d.id,signature,nearRaw:funded.receivedRaw}};}}
  const existing = d.phase==='conversion'?null:await read("receipts/" + d.mint + ".json");
  if (existing) {
    if (existing.signature !== signature)
      fail("The mint has another confirmed launch record.");
    await removePending(saved);
    return { status: "confirmed", coin: publicCoin(existing) };
  }
  if(d.bundle)return bundleStatus(d,saved,broadcast);
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
    return finalizeLaunch(d,saved,tx);
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
async function finalizeLaunch(d,saved,buyReceipt){
  const rpc=connection(),signature=saved.signature;
  await verifyFeeAssignment(rpc,d.mint,d.feeTreasury||d.creator,NEAR,d.creatorFeeBps);
  const mint=await rpc.getAccountInfo(new PublicKey(d.mint),'finalized');
  if(!mint||!mint.owner.equals(TOKEN_2022_PROGRAM_ID))fail('The launched token mint could not be verified.');
  const state=unpackMint(new PublicKey(d.mint),mint,TOKEN_2022_PROGRAM_ID);
  if(state.decimals!==6||state.freezeAuthority!==null)fail('The launched mint differs from the supported token standard.');
  if(d.atomicSolBuy||(d.bundle&&BigInt(d.devBuyRaw)>0n))verifyAtomicLaunchReceipt(buyReceipt,d,d.atomicSolBuy?0n:BigInt(d.devBuyRaw));
  const coin={...d,signature,settlementSignatures:saved.signatures||[signature],verifiedAt:new Date().toISOString(),supply:state.supply.toString(),decimals:state.decimals};
  delete coin.wire;delete coin.wires;delete coin.image;delete coin.simulationAddresses;
  await createOnce('receipts/'+d.mint+'.json',coin,(a,b)=>a.signature===b.signature);
  await removePending(saved);return {status:'confirmed',coin:publicCoin(coin)};
}
async function bundleStatus(d,saved,broadcast){
  if(!Array.isArray(saved.wires)||!Array.isArray(saved.signatures)||saved.wires.length!==d.wires.length||saved.signatures.length!==d.wires.length)fail('The saved bundle is incomplete. Keep the original review.');
  const rpc=connection();
  if(broadcast)await checkNetwork(rpc,'mainnet');
  const states=(await rpc.getSignatureStatuses(saved.signatures,{searchTransactionHistory:true})).value;
  if(states.length!==saved.signatures.length)fail('The bundle signature lookup was incomplete.',503);
  if(states.every(s=>s?.confirmationStatus==='finalized'&&!s.err)){
    const receipts=await Promise.all(saved.signatures.map(signature=>readLaunchReceipt(rpc,signature)));
    if(receipts.some((tx,i)=>!tx?.meta||tx.meta.err||!messageMatchesReceipt(saved.wires[i],tx)))fail('The full finalized bundle receipt is not yet verified. Keep checking the original launch.');
    let total=0n;
    for(const tx of receipts){
      const before=tx.meta.preBalances[0],after=tx.meta.postBalances[0];
      if(!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||before<0||after<0)fail('The finalized bundle SOL debits could not be reconciled.');
      total+=BigInt(before)-BigInt(after);
    }
    if(total<=0n||total>BigInt(d.estimatedSolRaw))fail('The finalized bundle exceeds its reviewed total SOL budget. Keep the original receipts for reconciliation.');
    return finalizeLaunch({...d,solDebitedRaw:String(total),settlementSlots:receipts.map(tx=>tx.slot)},saved,receipts[d.tradeIndex??d.creationIndex]);
  }
  const expired=(await rpc.getBlockHeight('finalized'))>d.lastValidBlockHeight;
  const mintExists=expired?!!await rpc.getAccountInfo(new PublicKey(d.mint),'finalized'):false;
  const progress=bundleProgress(states,{expired,mintExists});
  if(progress==='review'||progress==='failed'){await removePending(saved);return {status:progress,signature:saved.signature,mint:d.mint};}
  if(progress==='confirming'||progress==='reconciling')return {status:progress,signature:saved.signature,mint:d.mint,error:progress==='reconciling'?'The full bundle needs reconciliation. Keep every original signature; no replacement payment is requested.':undefined};
  if(!broadcast){
    const [blocked,attempted]=await Promise.all([read('submission-checks/'+d.id+'.json'),read('broadcasts/'+d.id+'.json')]);
    return blocked&&!attempted?blockedLaunchResult(d,saved.signature,blocked.error):{status:'checking',signature:saved.signature,mint:d.mint};
  }
  try{
    // Exactly the signed bundle, sequentially: a standalone transaction sim
    // cannot see the preceding account/mint creation and is not sufficient.
    const sim=await simulateLaunchBundle(rpc,saved.wires,d.simulationAddresses,{signed:true});
    const debit=verifyBundleSimulation(d,sim);
    if(debit>BigInt(d.estimatedSolRaw))return recordBlocked(d,saved,'The signed bundle exceeds its reviewed total SOL budget. Submission was blocked.');
  }catch(error){if(error.safe)return recordBlocked(d,saved,error.message);throw error;}
  await createOnce('broadcasts/'+d.id+'.json',{id:d.id,signature:saved.signature,attemptedAt:Date.now(),relay:'jito'},(a,b)=>a.signature===b.signature);
  // Never fall back to sendRawTransaction: it would lose bundle ordering.
  const bundleId=await jitoRequest('sendBundle',[saved.wires,{encoding:'base64'}]);
  if(typeof bundleId!=='string'||!(/^[a-f0-9]{64}$/i).test(bundleId))fail('The launch relay response could not be verified. Keep the original signatures.',503);
  await createOnce('bundles/'+d.id+'.json',{id:d.id,bundleId,signature:saved.signature},(a,b)=>a.bundleId===b.bundleId);
  return {status:'submitted',signature:saved.signature,mint:d.mint,bundleId};
}

async function recordBlocked(d,saved,error){
  await createOnce('submission-checks/'+d.id+'.json',{id:d.id,signature:saved.signature,error,checkedAt:Date.now()},(a,b)=>a.signature===b.signature);
  return blockedLaunchResult(d,saved.signature,error);
}
export function verifyAtomicLaunchReceipt(tx,d,priorNearDebit=0n){
  // The exact signed message has already been verified. Its swap must not
  // consume pre-existing NEAR or another wallet token, and its buy must credit
  // the new mint to the launching wallet's canonical Token-2022 account.
  verifyConversionReceipt(tx,{...d,devBuyRaw:String(-priorNearDebit)});
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
