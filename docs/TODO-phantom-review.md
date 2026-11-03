# Phantom launch warning investigation

## Current fix — separate confirmed approvals (2026-11-03)

The owner approved replacing dependent bundle approvals with standalone, individually simulated v1 phases:
account setup; creation plus immutable fee assignment together; optional SOL conversion plus initial buy together.
Each phase finalizes before the next review is prepared. Creation publishes the coin even if the buy is canceled.
New launches use RPC preflight, not Jito; existing signed bundles retain their original recovery rules.

This removes the known missing-mint simulation dependency. Wallet-added Lighthouse assertions are retained and
validated. It does not prove that Phantom will stop displaying every warning: actual owner-wallet approval and
funded launch acceptance remain outstanding. If the warning persists, use Phantom's current transaction/domain
review guidance with this new flow; the historical bundle form below no longer describes new launches.

Source: https://docs.phantom.com/recipes/transactions/resolve-transaction-simulation-warnings .

## Historical bundle investigation and unsubmitted review draft

Phantom shows "This dApp could be malicious. Do not proceed unless you are certain it is safe." on launches.
Phantom's docs (https://docs.phantom.com/developer-powertools/domain-and-transaction-warnings, read 2026-11-03)
say this appears "when Phantom is unable to safely predict a transaction's outcome before execution".

## Why it happens (measured 2026-11-03, read-only mainnet simulation, nothing signed or sent)
The launch asks the wallet to sign one 3-transaction v0 Jito bundle (`lib/launch-bundle.mjs`). A wallet simulates
each transaction on its own against current state:
- `setup` alone: passes. `create` alone: passes.
- `fees` alone: fails, `CreateFeeSharingConfig` → `AccountNotInitialized` (3012) on the mint, because the coin only
  exists after `create` lands. The initial buy has the same dependency.

It can't be removed without dropping the all-or-nothing bundle: create+fees in one v0 transaction is 1096 bytes
(136 B left for wallet checks, rule is 200) and failed simulation with `InvalidAccountData`; create+fees+buy is
1260 bytes, over the 1232 limit. Owner decision 2026-11-03: request a Phantom review, no code change.

## Steps
1. Open Phantom's review form: https://docs.google.com/forms/d/1JgIxdmolgh_80xMfQKBKx9-QPC7LRdN6LHpFFW8BlKM/viewform
2. Paste the text below into the matching fields, and add your contact email.
3. Re-test a small launch in Phantom after they reply.

## Draft for the form
> **Domain:** https://www.intentpad.fun (also intentpad.fun)
>
> **What it is:** Intent Pad, a Pump.fun token launchpad. Coins are created through Pump.fun's own programs, paired
> with NEAR (wNEAR quote mint 3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG), with an immutable creator-fee assignment.
>
> **Warning seen:** "This dApp could be malicious" on the launch approval.
>
> **Why simulation fails:** the launch is one Jito bundle of three v0 transactions, all with the user's wallet as fee
> payer, signed in one Wallet Standard `signTransaction` request. Phantom signs first; the browser-generated mint
> keypair co-signs only the creation transaction afterwards. Transaction 1 creates the user's token accounts;
> transaction 2 calls Pump.fun `createV2` (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P) plus a Jito tip; transaction 3
> calls the Pump fee program (pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ) to lock the creator fee, and optionally
> the creator's initial buy. Transaction 3 depends on the mint created by transaction 2, so it can't simulate on
> its own (AccountNotInitialized). The bundle lands together or not at all, which is what keeps the fee lock
> atomic with creation.
>
> **Our checks:** before asking for a signature, the server simulates the exact bundle in order with
> `simulateBundle` and refuses to continue if any step fails. After signing it checks the wallet's bytes and
> simulates again before sending. All transactions use one frozen address lookup table
> (Dwqo7CH4vE5Xw4z4q1JySPsLXQEvYgELdZjrMTDzsMEK). The user pays network fees, Pump.fun's creation cost, a
> disclosed Jito tip and, optionally, their own initial buy (SOL may first be converted to wNEAR through
> Jupiter). The fee lock assigns the coin's future creator fees to the Intent Pad rewards treasury
> (CEjir9fXrSHekh6YFsH1ut9naumsBnoyssboy6nDRXLQ), which pays holder rewards; this is shown before approval.
>
> **Request:** review the domain and the bundle flow, or tell us how to present dependent bundle transactions so
> Phantom can simulate them in order.
