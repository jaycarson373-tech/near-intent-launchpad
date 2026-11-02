export type Market = {
  mint: string;
  name: string;
  symbol: string;
  price: number | null;
  updatedAt: string | null;
  status: string;
  icon?: string | null;
};
export type TokenInfo = {
  account: string;
  network: string;
  metadata: {
    name: string;
    symbol: string;
    decimals: number;
    icon?: string | null;
  };
  supply: string;
  verifiedAt: string;
};
export const price = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumSignificantDigits: 5,
      }).format(n)
    : "—";
export function tokenUnits(raw: string, decimals: number) {
  if (
    !/^\d+$/.test(raw) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 24
  )
    return "—";
  const n = BigInt(raw),
    scale = 10n ** BigInt(decimals);
  return (
    new Intl.NumberFormat("en-US").format(n / scale) +
    (n % scale
      ? "." +
        (n % scale)
          .toString()
          .padStart(decimals, "0")
          .slice(0, 6)
          .replace(/0+$/, "")
      : "")
  );
}
export const safeIcon = (url: unknown) =>
  typeof url === "string" &&
  (/^https:\/\//i.test(url) ||
    (/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(url) &&
      url.length < 200000))
    ? url
    : null;
