import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  AccountLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { aggregate } from "../worker/snapshot.mjs";
import {
  verifyJobReceipt,
  nearAta,
  distributionEvents,
  PROTECTED_SOL,
} from "../worker/chain.mjs";
import { compileLaunchV1 } from "../lib/launch-wire.mjs";
import { NEAR } from "../lib/solana-rpc.mjs";
const mint = Keypair.generate().publicKey,
  a = Keypair.generate(),
  b = Keypair.generate(),
  treasury = Keypair.generate();
function account(owner, amount) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    pubkey: Keypair.generate().publicKey,
    account: {
      owner: TOKEN_2022_PROGRAM_ID,
      data,
      lamports: 1,
      executable: false,
    },
  };
}
test("holder snapshots aggregate every token account once and require complete supply", () => {
  const rows = [
    account(a.publicKey, 2n),
    account(a.publicKey, 3n),
    account(b.publicKey, 4n),
    account(treasury.publicKey, 1n),
  ];
  assert.deepEqual(
    aggregate(rows, {
      mint,
      program: TOKEN_2022_PROGRAM_ID,
      supply: 10n,
      excluded: [treasury.publicKey.toBase58()],
    }),
    Object.fromEntries(
      [
        [a.publicKey.toBase58(), "5"],
        [b.publicKey.toBase58(), "4"],
      ].sort(([x], [y]) => x.localeCompare(y)),
    ),
  );
  assert.throws(
    () =>
      aggregate([...rows, rows[0]], {
        mint,
        program: TOKEN_2022_PROGRAM_ID,
        supply: 12n,
      }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      aggregate(rows, { mint, program: TOKEN_2022_PROGRAM_ID, supply: 11n }),
    /total supply/,
  );
});
test("authenticated payout receipt requires exact signed message and both treasury debit and recipient credit", () => {
  const source = nearAta(treasury.publicKey.toBase58()),
    dest = nearAta(a.publicKey.toBase58()),
    tx = compileLaunchV1({
      payer: treasury.publicKey,
      latest: {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 100,
      },
      instructions: [
        createTransferCheckedInstruction(
          source,
          new PublicKey(NEAR),
          dest,
          treasury.publicKey,
          10n,
          9,
          [],
          TOKEN_PROGRAM_ID,
        ),
      ],
    }),
    keys = tx.message.staticAccountKeys,
    idx = (p) => keys.findIndex((k) => k.equals(p)),
    row = (p, raw) => ({
      accountIndex: idx(p),
      mint: NEAR,
      uiTokenAmount: { amount: raw },
    }),
    job = {
      wire: Buffer.from(tx.serialize()).toString("base64"),
      plan: JSON.stringify({
        kind: "payout",
        treasury: treasury.publicKey.toBase58(),
        maxSolDebit: "10000",
        rows: [
          { owner: a.publicKey.toBase58(), ata: dest.toBase58(), raw: "10" },
        ],
      }),
    },
    receipt = {
      transaction: { message: tx.message },
      meta: {
        err: null,
        preBalances: [Number(PROTECTED_SOL + 1000000n)],
        postBalances: [Number(PROTECTED_SOL + 995000n)],
        preTokenBalances: [row(source, "100")],
        postTokenBalances: [row(source, "90"), row(dest, "10")],
      },
    };
  assert.equal(verifyJobReceipt(receipt, job).rows[0].raw, "10");
  const bad = structuredClone(receipt.meta);
  bad.postTokenBalances[1].uiTokenAmount.amount = "9";
  assert.throws(
    () => verifyJobReceipt({ ...receipt, meta: bad }, job),
    /Recipient/,
  );
  assert.throws(
    () =>
      verifyJobReceipt(
        {
          ...receipt,
          meta: { ...receipt.meta, err: { InstructionError: [0, "fail"] } },
        },
        job,
      ),
    /Successful/,
  );
  assert.throws(
    () =>
      verifyJobReceipt(
        {
          ...receipt,
          meta: { ...receipt.meta, postBalances: [Number(PROTECTED_SOL - 1n)] },
        },
        job,
      ),
    /SOL cost/,
  );
});
test("a foreign program cannot forge a Pump creator-fee event", () => {
  const data = Buffer.from([165, 55, 129, 112, 4, 179, 202, 40]).toString(
      "base64",
    ),
    foreign = Keypair.generate().publicKey.toBase58();
  assert.deepEqual(
    distributionEvents([
      "Program " + foreign + " invoke [1]",
      "Program data: " + data,
      "Program " + foreign + " success",
    ]),
    [],
  );
  assert.throws(
    () =>
      distributionEvents([
        "Program " + foreign + " invoke [1]",
        "Program " + Keypair.generate().publicKey.toBase58() + " success",
      ]),
    /scope/,
  );
});
