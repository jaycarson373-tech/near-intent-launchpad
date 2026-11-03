// One owner-created, frozen address lookup table shrinks the launch bundle transactions.
// The server only uses it after proving it is frozen, never deactivating and exactly the reviewed list.
import { createHash } from "node:crypto";
import {
  Keypair,
  PublicKey,
  AddressLookupTableAccount,
  AddressLookupTableProgram,
} from "@solana/web3.js";
import { fail } from "./http.js";
import { launchParts, buyInstructions } from "./launch-bundle.mjs";
import { solConversion } from "./sol-dev-buy.mjs";
import { configuredTreasury } from "./reward-readiness.mjs";
export const LOOKUP_TABLE_CACHE_MS = 600000;
const NEVER_DEACTIVATED = 18446744073709551615n;
// Lowercase hex sha256 of the base58 addresses, de-duplicated, default JS sort, joined by "\n".
export const lookupTableDigest = (list) =>
  createHash("sha256").update([...new Set(list.map(String))].sort().join("\n")).digest("hex");
let cached = null;
export function resetLookupTableCache() {
  cached = null;
}
export async function launchLookupTable(rpc, { env = process.env, now = Date.now() } = {}) {
  const address = env.INTENT_LOOKUP_TABLE, digest = String(env.INTENT_LOOKUP_TABLE_SHA256 || "");
  let key = null;
  try {
    if (typeof address === "string") key = new PublicKey(address);
  } catch {
    key = null;
  }
  if (!key || !/^[0-9a-f]{64}$/.test(digest))
    fail("The launch address table needs configuration. No wallet approval was requested.", 503);
  if (cached && cached.address === key.toBase58() && cached.digest === digest && now < cached.until) return cached.table;
  let info;
  try {
    info = await rpc.getAccountInfo(key, "finalized");
  } catch {
    fail("The launch address table could not be loaded. No wallet approval was requested.", 503);
  }
  let state = null;
  try {
    if (info?.owner?.equals(AddressLookupTableProgram.programId)) state = AddressLookupTableAccount.deserialize(info.data);
  } catch {
    state = null;
  }
  if (
    !state ||
    state.authority != null ||
    BigInt(state.deactivationSlot) !== NEVER_DEACTIVATED ||
    !state.addresses.length ||
    lookupTableDigest(state.addresses.map((k) => k.toBase58())) !== digest
  )
    fail("The launch address table is not the verified frozen table. No wallet approval was requested.", 503);
  const table = new AddressLookupTableAccount({ key, state });
  cached = { address: key.toBase58(), digest, until: now + LOOKUP_TABLE_CACHE_MS, table };
  return table;
}
const keysOf = (ixs) => new Set(ixs.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]));
const both = (a, b) => [...a].filter((k) => b.has(k));
const VENUES = ["Raydium CLMM", "Raydium CP", "Meteora DLMM"];
// Every account two independent launches share is fixed: anything derived from the creator, the
// mint or a signer differs between the samples and is dropped. Tip accounts are never included.
export async function fixedLaunchAccounts(c, { includeConversionPools = false, treasury = configuredTreasury(), transport = fetch, solRaw = 100000000n } = {}) {
  if (!treasury) throw Error("Set INTENT_TREASURY_ADDRESS before deriving the launch lookup table.");
  const sample = async () => {
    const creator = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
    const { setup, create, fees } = await launchParts(
      { creator, mint, feeTreasury: treasury, name: "Sample", symbol: "SAMPLE", uri: "https://example.invalid/m", creatorFeeBps: c.quote.creatorFeeBps, devBuyRaw: 0n },
      c,
    );
    const buy = await buyInstructions({ creator, mint, devBuyRaw: 1000000000n, amount: 1000000n, c });
    return { keys: keysOf([...setup, ...create, ...fees, ...buy]), mint };
  };
  const [a, b] = [await sample(), await sample()];
  const fixed = new Set(both(a.keys, b.keys));
  if (includeConversionPools) {
    let sampled = 0;
    for (const venue of VENUES) {
      const only = (u, init) => (u.searchParams.get("dexes") === venue ? transport(u, init) : Promise.resolve(new Response("", { status: 400 })));
      const routes = [];
      for (const s of [a, b]) {
        try {
          const r = await solConversion(Keypair.generate().publicKey.toBase58(), solRaw, { mint: s.mint.toBase58(), treasury, transport: only });
          routes.push(keysOf(r.instructions));
        } catch {
          break;
        }
      }
      if (routes.length !== 2) continue;
      sampled++;
      for (const k of both(routes[0], routes[1])) fixed.add(k);
    }
    if (!sampled) throw Error("No SOL conversion route could be sampled for the lookup table.");
  }
  const list = [...fixed].sort();
  if (list.length > 256) throw Error("The launch lookup table would exceed 256 addresses.");
  return list;
}
