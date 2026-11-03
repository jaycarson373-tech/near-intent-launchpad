import { readCurve } from "../lib/curve-reader.mjs";
import { send, handleError, fail } from "../lib/http.js";
import { read } from "../lib/store.js";
import { publicCoin, address } from "../lib/launch-model.js";
const metric = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") fail("Method not allowed.", 405);
    const mint = new URL(req.url, "https://intentpad.local").searchParams.get(
      "mint",
    );
    address(mint);
    const d = await read("receipts/" + mint + ".json");
    if (!d)
      fail("No confirmed Intent Pad launch was found for this mint.", 404);
    const curveRead = readCurve(mint, d.quoteMint)
      .then((curve) => ({ curve, curveStatus: "available" }))
      .catch(() => ({ curve: null, curveStatus: "unavailable" }));
    let market = null,
      marketStatus = "unavailable";
    try {
      const r = await fetch(
        "https://api.dexscreener.com/latest/dex/tokens/" + mint,
        { signal: AbortSignal.timeout(8000) },
      );
      if (r.ok) {
        marketStatus = "pending";
        const data = await r.json(),
          pairs = (data.pairs || []).filter(
            (p) =>
              p.chainId === "solana" &&
              p.baseToken?.address === mint &&
              p.quoteToken?.address === d.quoteMint &&
              typeof p.pairAddress === "string" &&
              /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.pairAddress),
          );
        pairs.sort(
          (a, b) =>
            Number(b.quoteToken?.address === d.quoteMint) -
              Number(a.quoteToken?.address === d.quoteMint) ||
            (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0),
        );
        const p = pairs[0];
        if (p) {
          marketStatus = "available";
          market = {
            pair: p.pairAddress,
            quoteSymbol: p.quoteToken.symbol,
            quoteMint: p.quoteToken.address,
            priceUsd: metric(p.priceUsd),
            marketCap: metric(p.marketCap),
            volume24h: metric(p.volume?.h24),
            liquidity: metric(p.liquidity?.usd),
          };
        }
      }
    } catch {}
    send(res, 200, {
      coin: publicCoin(d),
      market,
      marketStatus,
      ...(await curveRead),
    });
  } catch (error) {
    handleError(res, error);
  }
}
