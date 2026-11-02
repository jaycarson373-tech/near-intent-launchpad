import test from "node:test";
import assert from "node:assert/strict";
import {
  checkedNearPrice,
  checkedCoinbasePrice,
  priceReader,
} from "../lib/near-price.mjs";
const now = 1793608300000,
  body = {
    near: { usd: 4.1, usd_24h_change: -6.4, last_updated_at: now / 1000 },
  };
test("native NEAR price validates identity, numeric values and provider freshness", () => {
  assert.equal(checkedNearPrice(body, now).usd, 4.1);
  assert.equal(checkedNearPrice(body, now).change24h, -6.4);
  for (const data of [
    { ethereum: body.near },
    { near: { ...body.near, usd: 0 } },
    { near: { ...body.near, usd: "4.1" } },
    { near: { ...body.near, last_updated_at: (now - 1000000) / 1000 } },
    { near: { ...body.near, last_updated_at: (now + 100000) / 1000 } },
  ])
    assert.throws(() => checkedNearPrice(data, now));
  assert.equal(
    checkedNearPrice(
      {
        ...body,
        near: { ...body.near, last_updated_at: (now - 400000) / 1000 },
      },
      now,
    ).status,
    "delayed",
  );
});
test("price polling coalesces requests and marks cached values delayed on failure, then expires them", async () => {
  let time = now,
    calls = 0,
    fail = false;
  const read = priceReader({
    clock: () => time,
    transport: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      if (fail) throw Error("offline");
      return { ok: true, json: async () => body };
    },
  });
  const values = await Promise.all([read(), read(), read()]);
  assert.equal(calls, 1);
  assert.equal(values[0].status, "fresh");
  await read();
  assert.equal(calls, 1);
  time += 61000;
  fail = true;
  assert.equal((await read()).status, "delayed");
  assert.equal(calls, 3);
  time += 1000000;
  assert.equal(await read(), null);
  assert.equal(calls, 5);
});

test("fallback ticker uses the NEAR/USD product and a real trade time without inventing 24h change", async () => {
  const ticker = { price: "4.12", time: new Date(now).toISOString() };
  assert.equal(checkedCoinbasePrice(ticker, now).change24h, null);
  assert.throws(() =>
    checkedCoinbasePrice({ ...ticker, time: "invalid" }, now),
  );
  const read = priceReader({
    clock: () => now,
    transport: async (url) => {
      if (url.includes("coingecko")) throw Error("offline");
      assert.equal(
        url,
        "https://api.exchange.coinbase.com/products/NEAR-USD/ticker",
      );
      return { ok: true, json: async () => ticker };
    },
  });
  assert.equal((await read()).source, "Coinbase Exchange");
});
