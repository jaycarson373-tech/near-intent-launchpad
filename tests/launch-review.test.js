import test from "node:test";
import assert from "node:assert/strict";
import { unsignedReviewDetails } from "../lib/launch-review.mjs";
const saved = {
  creator: "owner",
  publicKey: "mint",
  review: { creator: "owner", mint: "mint", expiresAt: 1 },
  details: { name: "Coin", devBuySol: "0.01" },
  privateKey: { testOnly: true },
  retired: [{ signature: "old" }],
};
test("expired unsigned reviews retain original mint, details and history while returning fresh editable details", () => {
  const original = structuredClone(saved),
    details = unsignedReviewDetails(saved, "owner");
  assert.deepEqual(details, saved.details);
  assert.notEqual(details, saved.details);
  assert.deepEqual(saved, original);
});
test("refresh cannot replace signed, partial bundle or foreign-wallet recovery state", () => {
  for (const patch of [
    { signed: new Uint8Array([1]) },
    { signature: "signature" },
    { bundleSigned: [new Uint8Array([1])] },
    { creator: "other" },
    { review: { creator: "owner", mint: "other" } },
  ])
    assert.throws(() => unsignedReviewDetails({ ...saved, ...patch }, "owner"));
  assert.throws(() => unsignedReviewDetails(undefined, "owner"));
});
