// Jito Block Engine client for atomic launch bundles (sendBundle, status, tip accounts).
// Paths and shapes probed read-only on 2026-11-02: every method answers at /api/v1/bundles;
// getInflightBundleStatuses reports Pending | Landed | Failed | Invalid (5-minute look-back).
// Public limit: about 1 request/second per IP per region, so callers resend at most every 2 s.
// A dropped or failed bundle lands nothing and charges nothing (the tip lives inside the bundle).
import { redact } from "./http.js";

const DEFAULT_ENGINE = "https://mainnet.block-engine.jito.wtf";
const TIP_CACHE_MS = 600000;
let tipCache = null;

function tipLamports(raw) {
  if (!raw || !/^\d{1,12}$/.test(raw)) return 10000n;
  const n = BigInt(raw);
  return n < 1000n ? 1000n : n > 5000000n ? 5000000n : n; // floor: Jito minimum; cap: 0.005 SOL
}
export const JITO_TIP_LAMPORTS = tipLamports(process.env.JITO_TIP_LAMPORTS);

function engine() {
  const url = process.env.JITO_BLOCK_ENGINE_URL || DEFAULT_ENGINE;
  if (!url.startsWith("https://")) throw safe("Jito submission is not configured.", false);
  return url.replace(/\/+$/, "") + "/api/v1/bundles";
}
function safe(message, retryable, detail) {
  return Object.assign(new Error(message), { status: 503, safe: true, retryable, detail: redact(detail) });
}
async function call(method, params, options = {}) {
  const f = options.fetch || fetch;
  let response;
  try {
    response = await f(engine(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.JITO_AUTH_UUID ? { "x-jito-auth": process.env.JITO_AUTH_UUID } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    if (e?.safe) throw e;
    throw safe("Jito is unreachable right now. Your signed launch is saved and will be resent.", true, e?.message);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // handled below
  }
  const message = String(body?.error?.message || "");
  if (response.status === 429 || /rate.?limit/i.test(message))
    throw safe("Jito is busy. Your signed launch is saved and will be resent.", true, message || "HTTP 429");
  if (!response.ok || !body || body.error)
    throw safe("Jito did not accept the launch bundle. Nothing was charged.", false, message || "HTTP " + response.status);
  return body.result;
}

export async function jitoTipAccount(options = {}) {
  const now = options.now ?? Date.now();
  if (!tipCache || now - tipCache.at > TIP_CACHE_MS) {
    const accounts = await call("getTipAccounts", [], options);
    if (!Array.isArray(accounts) || !accounts.length || accounts.some((a) => typeof a !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)))
      throw safe("Jito tip accounts are unavailable. No wallet approval was requested.", true, "bad getTipAccounts result");
    tipCache = { at: now, accounts };
  }
  const pick = options.random ?? Math.random;
  return tipCache.accounts[Math.floor(pick() * tipCache.accounts.length) % tipCache.accounts.length];
}
export function resetJitoCache() {
  tipCache = null;
}

export async function sendJitoBundle(wiresBase64, options = {}) {
  if (!Array.isArray(wiresBase64) || wiresBase64.length < 1 || wiresBase64.length > 5 || wiresBase64.some((w) => typeof w !== "string" || !w))
    throw safe("Invalid launch bundle.", false, "bundle size");
  const id = await call("sendBundle", [wiresBase64, { encoding: "base64" }], options);
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/i.test(id))
    throw safe("Jito returned an unexpected bundle id. Your signed launch is saved and will be resent.", true, "bad sendBundle result");
  return id;
}

const STATES = { Pending: "pending", Landed: "landed", Failed: "failed", Invalid: "invalid" };
export async function jitoBundleStatus(bundleId, options = {}) {
  const result = await call("getInflightBundleStatuses", [[bundleId]], options);
  const row = result?.value?.find?.((r) => r?.bundle_id === bundleId);
  if (!row) return { state: "unknown" };
  const state = STATES[row.status] || "unknown";
  return Number.isSafeInteger(row.landed_slot) ? { state, slot: row.landed_slot } : { state };
}
