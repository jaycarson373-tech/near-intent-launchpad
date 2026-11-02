import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { NEAR } from "./solana-rpc.mjs";
import { create, read } from "./store.js";
import { fail } from "./http.js";
export const NEAR_ASSET = "1cs_v1:sol:spl:" + NEAR,
  SOL_ASSET = "nep141:sol.omft.near";
export function nearAmount(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,3})(\.\d{1,9})?$/.test(value)
  )
    fail("Enter a NEAR amount up to nine decimals.");
  const [n, f = ""] = value.split("."),
    raw = BigInt(n) * 10n ** 24n + BigInt(f.padEnd(24, "0"));
  if (raw <= 0n || raw > 1000n * 10n ** 24n)
    fail("Choose an amount between zero and 1,000 NEAR.");
  return raw.toString();
}
export function fundingRequest(input, dry = false) {
  if (!input || !["NEAR", "SOL"].includes(input.asset))
    fail("Choose NEAR or SOL funding.");
  let recipient;
  try {
    recipient = new PublicKey(input.recipient).toBase58();
    if (!PublicKey.isOnCurve(new PublicKey(recipient).toBytes())) throw Error();
  } catch {
    fail("Connect the Solana wallet that should receive this funding.");
  }
  if (
    typeof input.refundTo !== "string" ||
    input.refundTo.length < 2 ||
    input.refundTo.length > 64 ||
    !/^(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*$/.test(
      input.refundTo,
    )
  )
    fail("Enter the NEAR wallet that should receive any refund.");
  return {
    dry,
    depositMode: "SIMPLE",
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: "nep141:wrap.near",
    depositType: "ORIGIN_CHAIN",
    destinationAsset: input.asset === "SOL" ? SOL_ASSET : NEAR_ASSET,
    amount: nearAmount(input.amount),
    recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 15 * 60000).toISOString(),
  };
}
export function checkedQuote(result, request) {
  const r = result?.quoteRequest,
    q = result?.quote;
  if (
    !r ||
    !q ||
    [
      "originAsset",
      "destinationAsset",
      "amount",
      "recipient",
      "refundTo",
      "depositType",
      "recipientType",
      "refundType",
      "swapType",
      "deadline",
      "depositMode",
    ].some((k) => r[k] !== request[k]) ||
    r.slippageTolerance !== 100 ||
    r.dry !== request.dry ||
    q.amountIn !== request.amount ||
    !/^\d+$/.test(q.minAmountOut || "") ||
    !/^\d+$/.test(q.amountOut || "") ||
    BigInt(q.minAmountOut) <= 0n ||
    BigInt(q.minAmountOut) > BigInt(q.amountOut) ||
    BigInt(q.minAmountOut) < (BigInt(q.amountOut) * 9900n) / 10000n
  )
    fail("The provider quote does not match your funding request.");
  if (
    !request.dry &&
    (!/^[a-z0-9._-]{2,64}$/.test(q.depositAddress || "") ||
      q.depositMemo ||
      !Number.isFinite(Date.parse(q.deadline)) ||
      Date.parse(q.deadline) < Date.now() + 60000)
  )
    fail(
      "The provider returned an unsupported deposit format. No payment was requested.",
    );
  return result;
}
async function oneclick(path, input) {
  const r = await fetch("https://1click.chaindefuser.com/v0/" + path, {
    method: input ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(process.env.NEAR_INTENTS_JWT
        ? { Authorization: "Bearer " + process.env.NEAR_INTENTS_JWT }
        : {}),
    },
    body: input ? JSON.stringify(input) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok)
    fail(
      "The Intents route is unavailable for this amount. Try another amount or retry later.",
      503,
    );
  return r.json();
}
export async function fundingQuote(input) {
  const request = fundingRequest(input),
    result = checkedQuote(await oneclick("quote", request), request),
    id = randomUUID();
  await create("funding/" + id + ".json", {
    id,
    request,
    result,
    createdAt: Date.now(),
  });
  return {
    id,
    amountIn: result.quote.amountIn,
    amountOut: result.quote.amountOut,
    minAmountOut: result.quote.minAmountOut,
    amountOutFormatted: result.quote.amountOutFormatted,
    asset: input.asset === "SOL" ? "SOL" : "NEAR",
    depositAddress: result.quote.depositAddress,
    deadline: new Date(
      Math.min(Date.parse(result.quote.deadline), Date.parse(request.deadline)),
    ).toISOString(),
    recipient: request.recipient,
    refundTo: request.refundTo,
    sourceAsset: "wNEAR on NEAR",
    authenticated: !!process.env.NEAR_INTENTS_JWT,
  };
}
export async function fundingStatus(id) {
  if (!/^[a-f0-9-]{36}$/.test(id || "")) fail("Invalid funding receipt.");
  const saved = await read("funding/" + id + ".json");
  if (!saved) fail("Funding receipt not found.", 404);
  const result = await oneclick(
    "status?" +
      new URLSearchParams({
        depositAddress: saved.result.quote.depositAddress,
      }),
  );
  return {
    status: result.status,
    recipient: saved.request.recipient,
    refundTo: saved.request.refundTo,
    depositAddress: saved.result.quote.depositAddress,
    details: result.swapDetails || null,
  };
}
async function nearView(account, method, args = {}) {
  const r = await fetch("https://rpc.mainnet.near.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "intent-pad-funding",
      method: "query",
      params:
        method === "view_account"
          ? {
              request_type: "view_account",
              finality: "final",
              account_id: account,
            }
          : {
              request_type: "call_function",
              finality: "final",
              account_id: account,
              method_name: method,
              args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
            },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) fail("The NEAR account read is unavailable.", 503);
  const d = await r.json();
  if (d.error) fail("The NEAR funding wallet could not be verified.", 503);
  return method === "view_account"
    ? d.result
    : JSON.parse(Buffer.from(d.result.result).toString());
}
export function depositActions({
  amount,
  wrappedBalance,
  receiverStorage,
  ownerStorage = {},
  storageMinimum,
  owner,
  receiver,
}) {
  const raw = BigInt(amount),
    wrapped = BigInt(wrappedBalance),
    minimum = BigInt(storageMinimum);
  if (raw <= 0n || wrapped < 0n || minimum <= 0n || minimum > 10n ** 22n)
    fail("The wrapped NEAR storage configuration could not be verified.");
  if (ownerStorage === null && wrapped !== 0n)
    fail("The wrapped NEAR account returned inconsistent balances.");
  const actions = [];
  let storage = 0n;
  for (const [account_id, current] of [
    [owner, ownerStorage],
    [receiver, receiverStorage],
  ]) {
    if (current === null) {
      if (!account_id) fail("The funding storage owner could not be verified.");
      storage += minimum;
      actions.push({
        methodName: "storage_deposit",
        args: { account_id, registration_only: true },
        deposit: minimum.toString(),
      });
    }
  }
  const wrap = raw > wrapped ? raw - wrapped : 0n;
  if (wrap)
    actions.push({
      methodName: "near_deposit",
      args: {},
      deposit: wrap.toString(),
    });
  return {
    actions,
    nearRequired: (wrap + storage + 1n).toString(),
    wrap: wrap.toString(),
    storage: storage.toString(),
  };
}
export async function fundingPlan(id, owner) {
  if (!/^[a-f0-9-]{36}$/.test(id || "")) fail("Invalid funding quote.");
  const saved = await read("funding/" + id + ".json");
  if (!saved || saved.request.refundTo !== owner)
    fail("Connect the NEAR wallet used for this funding quote.");
  const q = saved.result.quote;
  if (
    !Number.isFinite(Date.parse(q.deadline)) ||
    Math.min(Date.parse(q.deadline), Date.parse(saved.request.deadline)) <
      Date.now() + 60000
  )
    fail(
      "The funding quote is too close to expiry. Check its status before requesting another.",
    );
  const [balance, receiverStorage, ownerStorage, bounds, account] =
    await Promise.all([
      nearView("wrap.near", "ft_balance_of", { account_id: owner }),
      nearView("wrap.near", "storage_balance_of", {
        account_id: q.depositAddress,
      }),
      nearView("wrap.near", "storage_balance_of", { account_id: owner }),
      nearView("wrap.near", "storage_balance_bounds"),
      nearView(owner, "view_account"),
    ]);
  const plan = depositActions({
    amount: saved.request.amount,
    wrappedBalance: balance,
    receiverStorage,
    ownerStorage,
    storageMinimum: bounds.min,
    owner,
    receiver: q.depositAddress,
  });
  if (
    BigInt(account.amount) <
    BigInt(plan.nearRequired) +
      50000000000000000000000n +
      BigInt(account.storage_usage) * 10000000000000000000n
  )
    fail(
      "The NEAR wallet needs enough funds for wrapping, storage and 0.05 NEAR gas headroom.",
    );
  plan.actions.push({
    methodName: "ft_transfer",
    args: {
      receiver_id: q.depositAddress,
      amount: saved.request.amount,
      memo: "Intent Pad funding",
    },
    deposit: "1",
  });
  return {
    ...plan,
    receiverId: "wrap.near",
    owner,
    depositAddress: q.depositAddress,
    recipient: saved.request.recipient,
    amount: saved.request.amount,
  };
}
