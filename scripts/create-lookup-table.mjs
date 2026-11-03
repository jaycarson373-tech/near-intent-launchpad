// One-time owner step: create the FROZEN address lookup table that v0 launch bundles need.
// Any funded wallet may create it: once frozen, nobody (including its creator) can change or close it,
// and the server only accepts a frozen table whose address list hashes to INTENT_LOOKUP_TABLE_SHA256.
//
// Dry run (default, sends nothing):   node scripts/create-lookup-table.mjs
// Create + freeze (~0.0067 SOL rent):  node scripts/create-lookup-table.mjs --execute --keypair /path/to/funded-keypair.json
// RPC: SOLANA_RPC_URL or HELIUS_RPC_URL if set, otherwise the public mainnet RPC.
// The keypair file is read only to sign; it is never printed. Prints two PUBLIC env lines at the end.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, Keypair, AddressLookupTableProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { context } from "../server/pump-launch.js";
import { fixedLaunchAccounts } from "../lib/lookup-table.mjs";

const TREASURY = "CEjir9fXrSHekh6YFsH1ut9naumsBnoyssboy6nDRXLQ";
process.env.INTENT_TREASURY_ADDRESS ||= TREASURY; // public; the table includes its wNEAR account
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const execute = process.argv.includes("--execute");
const rpc = new Connection(process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

const c = await context(30, rpc);
const addresses = [...new Set((await fixedLaunchAccounts(c, { includeConversionPools: true })).map(String))].sort();
if (!addresses.length || addresses.length > 256) throw Error("Unexpected address count: " + addresses.length);
addresses.forEach((a) => new PublicKey(a));
const sha256 = createHash("sha256").update(addresses.join("\n")).digest("hex");
const rent = await rpc.getMinimumBalanceForRentExemption(56 + 32 * addresses.length);
console.log(addresses.length + " fixed addresses:\n" + addresses.map((a) => "  " + a).join("\n"));
console.log("SHA-256 of sorted list: " + sha256);
console.log("Rent (locked forever in the frozen table): " + rent / 1e9 + " SOL + ~0.00005 SOL fees");
if (!execute) { console.log("\nDry run only. Nothing was sent. Add --execute --keypair <file> to create and freeze."); process.exit(0); }

const file = arg("--keypair");
if (!file) throw Error("--execute needs --keypair <path to a funded Solana keypair JSON>.");
const secret = Uint8Array.from(JSON.parse(readFileSync(file, "utf8")));
const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
secret.fill(0);
const keep = payer.publicKey.toBase58() === TREASURY ? 30000000 : 1000000; // never drain the reward treasury
const balance = await rpc.getBalance(payer.publicKey, "confirmed");
if (balance < rent + keep + 100000) throw Error("Payer " + payer.publicKey.toBase58() + " needs at least " + (rent + keep + 100000) / 1e9 + " SOL.");
console.log("Payer/authority: " + payer.publicKey.toBase58());

async function send(instructions, label) {
  const latest = await rpc.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: latest.blockhash, instructions }).compileToV0Message());
  tx.sign([payer]);
  const signature = await rpc.sendTransaction(tx, { maxRetries: 3 });
  const result = await rpc.confirmTransaction({ signature, ...latest }, "finalized");
  if (result.value.err) throw Error(label + " failed: " + JSON.stringify(result.value.err) + " " + signature);
  console.log(label + ": " + signature);
}
// The create instruction needs a slot present in every node's SlotHashes. A load-balanced RPC can answer
// getSlot from a node ahead of the one that simulates ("is not a recent slot"), and skipped slots never
// appear, so use a produced (non-skipped) slot ~20 behind finalized and retry with a fresh one if needed.
let table;
for (let attempt = 1; ; attempt++) {
  const finalized = await rpc.getSlot("finalized");
  const produced = await rpc.getBlocks(finalized - 40, finalized - 20, "finalized");
  if (!produced.length) throw Error("No recent produced slot found; retry in a few seconds.");
  const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: produced.at(-1) });
  try {
    await send([create], "created table " + address.toBase58());
    table = address;
    break;
  } catch (error) {
    if (attempt >= 3 || !/not a recent slot/.test(String(error?.message) + JSON.stringify(error?.transactionLogs || []))) throw error;
    console.log("Slot not yet known to the simulating node; retrying with a fresh slot...");
    await new Promise((r) => setTimeout(r, 2000));
  }
}
for (let i = 0; i < addresses.length; i += 20)
  await send([AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: addresses.slice(i, i + 20).map((a) => new PublicKey(a)) })], "added " + Math.min(20, addresses.length - i) + " addresses");
const live = (await rpc.getAddressLookupTable(table, { commitment: "finalized" })).value;
if (!live || live.state.addresses.map(String).sort().join("\n") !== addresses.join("\n")) throw Error("Table contents do not match; NOT freezing. Table: " + table.toBase58());
await send([AddressLookupTableProgram.freezeLookupTable({ lookupTable: table, authority: payer.publicKey })], "froze table");
const frozen = (await rpc.getAddressLookupTable(table, { commitment: "finalized" })).value;
if (frozen?.state.authority) throw Error("Freeze not confirmed for " + table.toBase58());
console.log("\nINTENT_LOOKUP_TABLE=" + table.toBase58());
console.log("INTENT_LOOKUP_TABLE_SHA256=" + sha256);
console.log("Done. Set both (public) values on Vercel production and Railway, then redeploy.");
process.exit(0);
