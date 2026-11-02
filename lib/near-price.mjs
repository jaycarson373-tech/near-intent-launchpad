// Read-only native NEAR market reference. Never used for signing or settlement.
const FRESH_MS = 5 * 60_000;
const MAX_AGE_MS = 15 * 60_000;
export function checkedNearPrice(body, now = Date.now()) {
  const value = body?.near;
  if (
    !value ||
    typeof value.usd !== "number" ||
    !Number.isFinite(value.usd) ||
    value.usd <= 0 ||
    !Number.isSafeInteger(value.last_updated_at)
  )
    throw Error("Invalid NEAR market response.");
  const at = value.last_updated_at * 1000;
  if (at > now + 60_000 || now - at > MAX_AGE_MS)
    throw Error("NEAR price is stale.");
  return {
    usd: value.usd,
    change24h:
      typeof value.usd_24h_change === "number" &&
      Number.isFinite(value.usd_24h_change)
        ? value.usd_24h_change
        : null,
    asOf: at,
    source: "CoinGecko",
    url: "https://www.coingecko.com/en/coins/near",
    status: now - at > FRESH_MS ? "delayed" : "fresh",
  };
}
export function checkedCoinbasePrice(body, now = Date.now()) {
  const at = Date.parse(body?.time),
    usd = Number(body?.price);
  if (
    typeof body?.price !== "string" ||
    !/^\d+(\.\d+)?$/.test(body.price) ||
    !Number.isFinite(usd) ||
    usd <= 0 ||
    !Number.isFinite(at) ||
    at > now + 60000 ||
    now - at > MAX_AGE_MS
  )
    throw Error("Invalid NEAR/USD ticker.");
  return {
    usd,
    change24h: null,
    asOf: at,
    source: "Coinbase Exchange",
    url: "https://www.coinbase.com/price/near-protocol",
    status: now - at > FRESH_MS ? "delayed" : "fresh",
  };
}
export function priceReader({ transport = fetch, clock = Date.now } = {}) {
  let cached = null,
    expires = 0,
    pending;
  return async () => {
    if (clock() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const r = await transport(
          "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true",
          { signal: AbortSignal.timeout(6000), cache: "no-store" },
        );
        if (!r.ok) throw Error("Market provider unavailable.");
        cached = checkedNearPrice(await r.json(), clock());
      } catch {
        try {
          const r = await transport(
            "https://api.exchange.coinbase.com/products/NEAR-USD/ticker",
            { signal: AbortSignal.timeout(6000), cache: "no-store" },
          );
          if (!r.ok) throw Error("Fallback market provider unavailable.");
          cached = checkedCoinbasePrice(await r.json(), clock());
        } catch {
          cached =
            cached && clock() - cached.asOf <= MAX_AGE_MS
              ? { ...cached, status: "delayed" }
              : null;
        }
      }
      expires = clock() + 60_000;
      return cached;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}
export const nearPrice = priceReader();
