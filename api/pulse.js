import {publicActivity} from "../lib/public-directory.mjs";
import { send, fail, handleError } from "../lib/http.js";
import { nearPrice } from "../lib/near-price.mjs";
import { read, configured } from "../lib/store.js";
import { POLICY_HASH } from "../lib/reward-readiness.mjs";
import { NEAR } from "../lib/solana-rpc.mjs";
let cached,
  pending,
  expires = 0;
async function rewardActivity() {
  if (Date.now() < expires) return cached;
  if (pending) return pending;
  pending = (async () => {
    try {
      const value = configured() ? await read("rewards/activity.json") : null;
      cached =
        value?.policyHash === POLICY_HASH && value.assetMint === NEAR
          ? { status: "available", ...value, events: publicActivity(value.events) }
          : { status: "awaiting", events: [], totalDistributedRaw: null };
    } catch {
      cached = { status: "unavailable", events: [], totalDistributedRaw: null };
    }
    expires = Date.now() + 30_000;
    return cached;
  })().finally(() => {
    pending = null;
  });
  return pending;
}
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") fail("Method not allowed.", 405);
    const [market, activity] = await Promise.all([
      nearPrice(),
      rewardActivity(),
    ]);
    send(res, 200, { market, activity });
  } catch (e) {
    handleError(res, e);
  }
}
