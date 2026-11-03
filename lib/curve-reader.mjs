import { PublicKey } from "@solana/web3.js";
import { pump } from "./pump-adapter.mjs";
import { connection, NEAR, GENESIS } from "./solana-rpc.mjs";
import { curveMetrics } from "./curve-metrics.mjs";
export function curveReader({
  rpc = connection,
  clock = Date.now,
  ttl = 15000,
} = {}) {
  const cache = new Map();
  let network;
  return async function readCurve(mint, quoteMint = NEAR) {
    if (quoteMint !== NEAR) throw Error("Unsupported curve quote.");
    const key = new PublicKey(mint),
      old = cache.get(mint),
      now = clock();
    if (old && now - old.at < (old.failed ? 5000 : ttl)) return old.promise;
    const promise = (async () => {
      const client = rpc();
      network ??= client
        .getGenesisHash()
        .then((hash) => {
          if (hash !== GENESIS.mainnet) throw Error("Curve network mismatch.");
        })
        .catch((error) => {
          network = undefined;
          throw error;
        });
      await network;
      const address = pump.bondingCurvePda(key);
      const found = await client.getAccountInfoAndContext(address, {
        commitment: "finalized",
      });
      const info = found.value;
      if (
        !Number.isSafeInteger(found.context?.slot) ||
        !info ||
        !info.owner.equals(pump.PUMP_PROGRAM_ID)
      )
        throw Error("Curve account is not verified.");
      const curve = pump.PUMP_SDK.decodeBondingCurve(info);
      if (
        pump.normalizeQuoteMint(curve.quoteMint).toBase58() !== NEAR ||
        curve.tokenTotalSupply.toString() !== "1000000000000000"
      )
        throw Error("Curve identity differs from the verified launch.");
      return {
        ...curveMetrics(curve),
        quoteMint: NEAR,
        quoteDecimals: 9,
        address: address.toBase58(),
        slot: found.context.slot,
        observedAt: new Date(clock()).toISOString(),
      };
    })();
    cache.set(mint, { at: now, promise });
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    try {
      return await promise;
    } catch (error) {
      if (cache.get(mint)?.promise === promise) cache.get(mint).failed = true;
      throw error;
    }
  };
}
export const readCurve = curveReader();
