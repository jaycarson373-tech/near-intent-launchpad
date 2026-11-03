import {FEE_ALLOCATION_VERSION} from "./fee-allocation.mjs";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { REWARD_POLICY } from "./reward-policy.mjs";
import { read } from "./store.js";
export const POLICY_HASH = createHash("sha256")
  .update(JSON.stringify(REWARD_POLICY))
  .digest("hex");
export const heartbeatBytes = (value) =>
  Buffer.from("INTENTPAD:REWARDS_HEARTBEAT:v1\n" + JSON.stringify(value));
export function configuredTreasury() {
  try {
    const key = new PublicKey(process.env.INTENT_TREASURY_ADDRESS);
    if (!PublicKey.isOnCurve(key.toBytes()) || key.equals(PublicKey.default))
      throw Error();
    return key.toBase58();
  } catch {
    return null;
  }
}
export async function rewardReadiness() {
  const treasury = configuredTreasury();
  if (!treasury)
    return {
      ready: false,
      treasury: null,
      missing: ["reward treasury wallet"],
    };
  try {
    const { signature, ...state } =
      (await read("rewards/status/" + treasury + ".json")) || {};
    if (
      state.treasury !== treasury ||
      state.policyHash !== POLICY_HASH ||
      state.network !== "mainnet" ||
      !Number.isSafeInteger(state.checkedAt) ||
      state.checkedAt > Date.now() + 10000 ||
      Date.now() - state.checkedAt > 180000 ||
      !ed25519.verify(
        bs58.decode(signature),
        heartbeatBytes(state),
        new PublicKey(treasury).toBytes(),
      )
    )
      throw Error();
    if(state.feeAllocationVersion !== FEE_ALLOCATION_VERSION) return {ready:false,treasury,missing:["updated holder fee-routing worker"]};
    return {
      ready: state.ready === true,
      treasury,
      missing:
        state.ready === true
          ? []
          : ["reward worker: " + (state.reason || "not ready")],
    };
  } catch {
    return {
      ready: false,
      treasury,
      missing: ["active verified reward worker"],
    };
  }
}
