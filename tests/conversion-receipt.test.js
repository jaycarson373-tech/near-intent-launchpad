import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { verifyConversionReceipt } from "../server/pump-launch.js";
import { NEAR, SOL } from "../lib/solana-rpc.mjs";
const creator = Keypair.generate().publicKey.toBase58(),
  ata = getAssociatedTokenAddressSync(
    new PublicKey(NEAR),
    new PublicKey(creator),
  ).toBase58(),
  keys = [creator, ata, Keypair.generate().publicKey.toBase58()],
  record = { creator, devBuyRaw: "995", estimatedSolRaw: "10000" },
  row = (index, mint, amount) => ({
    accountIndex: index,
    mint,
    owner: creator,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    uiTokenAmount: { amount },
  }),
  message = {
    getAccountKeys: () => ({
      get: (i) => (keys[i] ? new PublicKey(keys[i]) : null),
    }),
  },
  meta = {
    preBalances: [100000],
    postBalances: [90000],
    preTokenBalances: [],
    postTokenBalances: [row(1, NEAR, "1000")],
  };
test("conversion credit must reach the exact wallet ATA and meet its saved floor", () => {
  assert.equal(
    verifyConversionReceipt({ transaction: { message }, meta }, record),
    "1000",
  );
  assert.throws(
    () =>
      verifyConversionReceipt(
        {
          transaction: { message },
          meta: { ...meta, postTokenBalances: [row(1, NEAR, "994")] },
        },
        record,
      ),
    /minimum/,
  );
  assert.throws(
    () =>
      verifyConversionReceipt(
        {
          transaction: { message },
          meta: { ...meta, postTokenBalances: [row(2, NEAR, "1000")] },
        },
        record,
      ),
    /minimum/,
  );
  assert.throws(
    () =>
      verifyConversionReceipt(
        { transaction: { message }, meta: { ...meta, postBalances: [89999] } },
        record,
      ),
    /minimum/,
  );
});
test("a conversion cannot silently spend another token or change its custody", () => {
  const other = Keypair.generate().publicKey.toBase58(),
    pre = [row(2, other, "10")],
    post = [row(1, NEAR, "1000"), row(2, other, "9")];
  assert.throws(
    () =>
      verifyConversionReceipt(
        {
          transaction: { message },
          meta: { ...meta, preTokenBalances: pre, postTokenBalances: post },
        },
        record,
      ),
    /another wallet token/,
  );
  assert.throws(
    () =>
      verifyConversionReceipt(
        {
          transaction: { message },
          meta: {
            ...meta,
            preTokenBalances: pre,
            postTokenBalances: [
              post[0],
              { ...post[1], owner: Keypair.generate().publicKey.toBase58() },
            ],
          },
        },
        record,
      ),
    /ownership/,
  );
  const wsol = row(2, SOL, "0");
  assert.equal(
    verifyConversionReceipt(
      {
        transaction: { message },
        meta: {
          ...meta,
          preTokenBalances: [wsol],
          postTokenBalances: meta.postTokenBalances,
        },
      },
      record,
    ),
    "1000",
  );
});
