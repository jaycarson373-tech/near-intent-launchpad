// Deliberate legacy compatibility boundary: Pump's official SDK uses web3.js v1.
import legacy from "./pump-legacy.cjs";
import BN from 'bn.js';
export const { pump, pumpSwap, web3, spl } = legacy;
import {SOL, GENESIS, publicKey, connection} from "./solana-rpc.mjs";
export {SOL, GENESIS, publicKey, connection};
export async function checkNetwork(rpc, network) {
  if ((await rpc.getGenesisHash()) !== GENESIS[network])
    throw Error("RPC network does not match the configured network.");
  const accounts = await rpc.getMultipleAccountsInfo([
    pump.PUMP_PROGRAM_ID,
    pump.PUMP_FEE_PROGRAM_ID,
  ]);
  if (accounts.some((a) => !a?.executable))
    throw Error("Pump programs are unavailable on this network.");
}
export async function launchInstructions({
  creator,
  mint,
  treasury,
  name,
  symbol,
  uri,
  operator,
  quote,
}) {
  const c = publicKey(creator),
    m = publicKey(mint),
    t = publicKey(treasury),d=operator?publicKey(operator):c;
  const quoteArgs = quote ? {quoteMint:publicKey(quote.mint),quoteTokenProgram:publicKey(quote.tokenProgram)} : {};
  const setup = quote ? [...new Map([t,c].map(k=>[k.toBase58(),k])).values(),pump.creatorVaultPda(pump.feeSharingConfigPda(m)),pump.ammCreatorVaultPda(pump.feeSharingConfigPda(m))].map(owner=>spl.createAssociatedTokenAccountIdempotentInstruction(d,spl.getAssociatedTokenAddressSync(publicKey(quote.mint),owner,true,publicKey(quote.tokenProgram)),owner,publicKey(quote.mint),publicKey(quote.tokenProgram))) : [];
  return [
    ...setup,
    await pump.PUMP_SDK.createV2Instruction({
      ...quoteArgs,
      creator: d,
      user: d,
      mint: m,
      name,
      symbol,
      uri,
      mayhemMode: false,
      cashback: false,
      holderReward: false,
      ...(quote?.creatorFeeBps?{creatorFeeBps:new BN(String(quote.creatorFeeBps))}:{}),
    }),
    await pump.PUMP_SDK.createFeeSharingConfig({
      creator: d,
      mint: m,
      pool: null,
    }),
    await pump.PUMP_SDK[quote ? "updateFeeSharesV2" : "updateFeeShares"]({
      ...quoteArgs,
      authority: d,
      mint: m,
      currentShareholders: [d],
      newShareholders: [{ address: t, shareBps: 10000 }],
      bondingCurveComplete: false,
    }),
  ];
}
export async function verifyFeeAssignment(rpc, mint, treasury, expectedQuote = SOL, expectedCreatorFeeBps) {
  const key = publicKey(mint),
    config = await rpc.getAccountInfo(
      pump.feeSharingConfigPda(key),
      "finalized",
    );
  if (!config?.owner.equals(pump.PUMP_FEE_PROGRAM_ID))
    throw Error("Verified Pump fee assignment not found.");
  const state = pump.PUMP_SDK.decodeSharingConfig(config);
  if (
    !state.mint.equals(key) ||
    state.shareholders.length !== 1 ||
    state.shareholders[0].address.toBase58() !== treasury ||
    state.shareholders[0].shareBps !== 10000
  )
    throw Error("Creator fees are not assigned 100% to this treasury.");
  if (pump.isSharingConfigEditable({ sharingConfig: state }))
    throw Error("Creator fee assignment is still editable.");
  const curve = await new pump.OnlinePumpSdk(rpc).fetchBondingCurve(key);
  if(expectedCreatorFeeBps!==undefined&&BigInt(curve.creatorFeeBps.toString())!==BigInt(expectedCreatorFeeBps))throw Error('Creator fee rate differs from its locked launch review.');
  if (
    !curve.creator.equals(pump.feeSharingConfigPda(key)) ||
    (curve.quoteMint &&
      (pump.normalizeQuoteMint(curve.quoteMint).toBase58() !== expectedQuote))
  )
    throw Error("Market does not match its locked fee-sharing quote.");
  return state;
}

