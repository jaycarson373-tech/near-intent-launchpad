// Beneficiary routing is distinct from the existing low-volume reserve timing.
// Version is locked into each new launch record; historical receipts stay v1.
export const INTENT_MINT = 'near4NKS2qYVPdJhKHPJgRQVzXbmkBgFu39TXfxd6ce';
export const FEE_ALLOCATION_VERSION = 2;
export function feeBeneficiaries(mint, raw, version = 1) {
  const n = BigInt(raw);
  if (n < 0n || ![1, 2].includes(version)) throw Error('Unsupported fee allocation.');
  if (version === 1 || mint === INTENT_MINT) return [{mint, raw: String(n)}];
  const platform = n * 2000n / 10000n;
  return [{mint, raw: String(n - platform)}, {mint: INTENT_MINT, raw: String(platform)}];
}
