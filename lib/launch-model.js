import { PublicKey } from "@solana/web3.js";
import { fail } from "./http.js";
export function address(value) {
  try {
    const k = new PublicKey(value);
    if (typeof value !== "string" || !PublicKey.isOnCurve(k.toBytes()))
      throw Error();
    return k;
  } catch {
    fail("Connect a valid Solana wallet and prepare a fresh mint.");
  }
}
export function units(value, decimals = 9, max = 1000000000000n) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,7})(\.\d{1,9})?$/.test(value)
  )
    fail("Enter an amount with up to nine decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const result =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"));
  if (result > max) fail("The initial buy exceeds the supported limit.");
  return result;
}
export function validate(input) {
  if(input.devBuyNear && input.devBuyNear!=="0") fail("The initial buy now uses SOL. Enter the SOL amount and prepare a fresh review.");
  const creator = address(input.creator),
    mint = address(input.mint);
  if (creator.equals(mint))
    fail("The mint must differ from the creator wallet.");
  const name = String(input.name || "").trim(),
    symbol = String(input.symbol || "")
      .trim()
      .toUpperCase(),
    description = String(input.description || "").trim();
  if (!name || Buffer.byteLength(name) > 32 || !/[\S]/.test(name))
    fail("Use a coin name of up to 32 UTF-8 bytes.");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol))
    fail("Use a ticker of up to ten letters or numbers.");
  if (description.length > 1000)
    fail("Keep the description under 1,000 characters.");
  const bps = input.creatorFeeBps;
  if (![30, 50, 100, 200, 300].includes(bps))
    fail("Choose an available creator fee.");
  for (const field of ["website", "twitter"])
    if (input[field]) {
      try {
        const u = new URL(input[field]);
        if (
          u.protocol !== "https:" ||
          u.username ||
          u.password ||
          u.href.length > 250
        )
          throw Error();
      } catch {
        fail("Use a valid HTTPS " + field + " URL.");
      }
    }
  const image = String(input.image || "");
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!match) fail("Choose a PNG, JPEG or WebP coin image.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 1500000 || bytes.length < 16)
    fail("Choose an image under 1.5 MB.");
  const valid =
    match[1] === "image/png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.subarray(0, 4).toString() === "RIFF" &&
          bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) fail("The image bytes do not match the selected image type.");
  return {
    creator,
    mint,
    name,
    symbol,
    description,
    creatorFeeBps: bps,
    devBuySolRaw: units(input.devBuySol || "0",9,100000000000n),
    devBuyRaw: 0n,
    image,
    mime: match[1],
    website: input.website || "",
    twitter: input.twitter || "",
  };
}
export const publicCoin = (d) => ({
  mint: d.mint,
  name: d.name,
  symbol: d.symbol,
  description: d.description,
  image: d.imageUrl,
  creator: d.creator,feeTreasury:d.feeTreasury||d.creator,rewardPolicyHash:d.rewardPolicyHash||null,
  creatorFeeBps: d.creatorFeeBps,
  quoteSymbol: "NEAR",
  quoteMint: d.quoteMint,
  signature: d.signature,
  createdAt: d.createdAt,
  verifiedAt: d.verifiedAt,
  status: "live",
  website: d.website || "",
  twitter: d.twitter || "",
});
