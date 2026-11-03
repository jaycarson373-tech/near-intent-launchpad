import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { curveMetrics } from "../lib/curve-metrics.mjs";
import { pump } from "../lib/pump-adapter.mjs";
const base = {
  virtualTokenReserves: "1073000000000000",
  virtualQuoteReserves: "3000000000000",
  realTokenReserves: "793100000000000",
  realQuoteReserves: "0",
  complete: false,
};
test("NEAR funding progress uses net quote reserves and the exact SDK completion quote", () => {
  const first = curveMetrics(base);
  assert.equal(first.progressBps, 0);
  assert.equal(first.raisedRaw, "0");
  const current = {
    ...base,
    virtualTokenReserves: "873000000000000",
    realTokenReserves: "593100000000000",
    virtualQuoteReserves: "3687285223368",
    realQuoteReserves: "687285223368",
  };
  const r = curveMetrics(current);
  const remaining = pump.getBuySolAmountFromTokenAmount({
    global: { feeBasisPoints: new BN(0), creatorFeeBasisPoints: new BN(0) },
    feeConfig: null,
    mintSupply: new BN("1000000000000000"),
    bondingCurve: {
      ...current,
      ...Object.fromEntries(
        Object.entries(current)
          .filter(([key]) => key !== "complete")
          .map(([key, value]) => [key, new BN(value)]),
      ),
      creator: pump.PUMP_PROGRAM_ID,
      quoteMint: pump.PUMP_PROGRAM_ID,
    },
    amount: new BN(current.realTokenReserves),
  });
  assert.equal(r.remainingRaw, remaining.toString());
  assert.equal(
    BigInt(r.targetRaw),
    BigInt(current.realQuoteReserves) + BigInt(remaining.toString()),
  );
  assert.ok(r.progressBps > 0 && r.progressBps < 10000);
  assert.ok(Number(r.priceNear) > Number(first.priceNear));
});
test("completed and migrated curves do not show moved liquidity as zero funds raised", () => {
  const complete = curveMetrics({
    ...base,
    realTokenReserves: "0",
    realQuoteReserves: "8000000000000",
    virtualQuoteReserves: "11000000000000",
    complete: true,
  });
  assert.equal(complete.progressBps, 10000);
  assert.equal(complete.remainingRaw, "0");
  const migrated = curveMetrics({
    virtualTokenReserves: "0",
    virtualQuoteReserves: "0",
    realTokenReserves: "0",
    realQuoteReserves: "0",
    complete: true,
  });
  assert.equal(migrated.phase, "migrated");
  assert.equal(migrated.raisedRaw, null);
  assert.equal(migrated.targetRaw, null);
});
test("invalid or inconsistent curve state cannot become progress or reserve numbers", () => {
  assert.throws(() =>
    curveMetrics({
      virtualTokenReserves: "0",
      virtualQuoteReserves: "0",
      realTokenReserves: "0",
      realQuoteReserves: "0",
      complete: false,
    }),
  );
  for (const patch of [
    { complete: undefined },
    { realQuoteReserves: "-1" },
    { realTokenReserves: base.virtualTokenReserves },
    { realTokenReserves: "0" },
    { virtualQuoteReserves: "0" },
    { realQuoteReserves: "999999999999999999999" },
    { complete: true },
  ])
    assert.throws(() => curveMetrics({ ...base, ...patch }));
});
