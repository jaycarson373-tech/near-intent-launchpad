// Read-only Pump curve accounting. All amounts stay in integer token units.
const raw = (value) => {
  const text = value?.toString();
  if (!/^\d{1,20}$/.test(text || "") || BigInt(text) > 18446744073709551615n)
    throw Error("Invalid curve reserve.");
  return BigInt(text);
};
export function curveMetrics(curve) {
  if (typeof curve?.complete !== "boolean") throw Error("Invalid curve state.");
  const vt = raw(curve.virtualTokenReserves),
    vq = raw(curve.virtualQuoteReserves),
    rt = raw(curve.realTokenReserves),
    rq = raw(curve.realQuoteReserves);
  if (vt === 0n && vq === 0n && rt === 0n && rq === 0n) {
    if (!curve.complete) throw Error("Uninitialized curve.");
    return {
      phase: "migrated",
      progressBps: 10000,
      raisedRaw: null,
      targetRaw: null,
      remainingRaw: null,
      priceNear: null,
    };
  }
  if (
    !vt ||
    !vq ||
    rt >= vt ||
    rq > vq ||
    (!curve.complete && rt === 0n) ||
    (curve.complete && rt !== 0n)
  )
    throw Error("Inconsistent curve reserves.");
  // Same fee-exclusive constant-product quote as Pump's official SDK. Rounding
  // is upward by one base unit. This is a live completion estimate, not a fixed
  // historical target or gross fees paid by traders.
  const remaining = curve.complete ? 0n : (rt * vq) / (vt - rt) + 1n;
  const target = rq + remaining;
  if (!target) throw Error("Empty curve target.");
  const priceScaled = (vq * 1000000n * 1000000000000n) / (vt * 1000000000n);
  return {
    phase: curve.complete ? "complete" : "bonding",
    progressBps: curve.complete ? 10000 : Number((rq * 10000n) / target),
    raisedRaw: rq.toString(),
    targetRaw: target.toString(),
    remainingRaw: remaining.toString(),
    priceNear:
      `${priceScaled / 1000000000000n}.${(priceScaled % 1000000000000n).toString().padStart(12, "0")}`.replace(
        /\.?0+$/,
        "",
      ),
  };
}
