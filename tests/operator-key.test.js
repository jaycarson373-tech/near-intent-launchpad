import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { operatorKey } from "../worker/chain.mjs";
import { heartbeatBytes } from "../lib/reward-readiness.mjs";

// Regression: operatorKey used to zero the array web3.js kept a reference to, so every heartbeat and payout
// was signed with an all-zero seed while the address check still passed.
test("a parsed operator key can still sign a heartbeat the site verifies", () => {
  const original = Keypair.generate();
  const address = original.publicKey.toBase58();
  for (const input of [JSON.stringify([...original.secretKey]), bs58.encode(original.secretKey)]) {
    const key = operatorKey(input, address);
    assert.equal(key.publicKey.toBase58(), address);
    assert.ok(key.secretKey.some((b) => b !== 0), "secret key must not be wiped");
    const message = heartbeatBytes({ treasury: address, ready: false, checkedAt: 1 });
    const signature = ed25519.sign(message, key.secretKey.slice(0, 32));
    assert.ok(ed25519.verify(signature, message, original.publicKey.toBytes()));
  }
  assert.throws(() => operatorKey(bs58.encode(original.secretKey), Keypair.generate().publicKey.toBase58()));
});
