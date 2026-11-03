# Intent Pad — NEAR-paired Solana release

## Scope and preserved state

The product now launches Pump.fun tokens on **Solana mainnet**, paired with wrapped NEAR (`3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG`, 9 decimals, SPL Token). The mint was checked against Pump's live QuoteControl. Native NEAR creation is no longer the primary UI. The pinned native contract, verification API, sandbox tests and browser receipt namespaces remain unchanged; earlier `?token=...` links still inspect the native token on NEAR.

The creation flow reuses PennyFun's official-SDK creation, immutable fee-sharing assignment, v1 wire encoding, wallet assertion validation and receipt recovery. Source revision: `b633d40af60f1aa1d7e24c63d5d8d6340913c054`. No Penny wallet, provider credential, ledger, paused worker or stock economics were imported. Creator-fee choices are 0.3%, 0.5%, 1%, 2%, 3%; **100% of each new reward-enabled coin’s creator fees are immutably assigned to the dedicated Intent reward treasury**. Pump protocol fees are separate. The previous, separate parent Intent Pad buyback/burn proposal remains unconfigured and inactive; this release does not activate it.

## Implementation

- Wallet Standard Solana connection; new SOL buys use one wallet batch approval for a Jito bundle: account setup, creation with immutable fee assignment, then the SOL conversion and initial buy in the same transaction, available only after complete sequential simulation and capacity checks. Previously finalized standalone conversions retain their recovery path. The user signs creation; the separate protected Railway operator signs only configured fee claims and holder payouts. The mint key remains browser-held.
- Non-extractable browser mint CryptoKey, wallet-specific IndexedDB draft and exact signed-wire recovery. A signed, unresolved transaction never silently becomes a new mint or a second payment.
- Private, dedicated Vercel Blob store: immutable reviews and signed outbox, then public receipt projection only after finalized successful transaction, message equality, mint and locked fee validation. Signed wires remain private.
- NEAR Intents / 1Click funding to the connected Solana wallet: exact recipient, assets, refund account, input and 1% slippage bound. Sender/receiver storage, only necessary wrapping, exact wNEAR transfer. Funding is a distinct NEAR wallet approval. A provider status is not treated as a confirmed wallet balance.
- A read-only directory refresh reconciles saved pending signatures, so confirmed launches can be published even after their creator closes the browser. It never broadcasts another transaction. Confirmed launch directory, persistent per-mint coin pages, creator wallet and transaction links, Pump market link. DEX Screener chart and figures only for a matching Solana token/pair; pending indexing has an explicit state.
- Mainnet genesis and Pump program checks; image byte/type/size validation; metadata and image public reachability before approval; signed-message, fee and reviewed SOL budget checks before broadcast.

## Required production configuration

Vercel project: `near-intent-launchpad`. Creation stays wallet-signed. The existing dedicated Railway service also hosts the persistent reward worker; its separate authenticated SQLite journal is durably checkpointed to this project’s private Blob store. No additional Supabase database is required.

- `BLOB_READ_WRITE_TOKEN`: server-only; linked to the dedicated private `intent-pad-launches` store. Already configured in production.
- `APP_ORIGIN`: optional canonical HTTPS origin; otherwise Vercel production URL is used. Must match the live site used for wallet reviews/metadata.
- `SOLANA_RPC_URL`: server-only authenticated mainnet RPC recommended before public traffic. Public Solana mainnet RPC is the fallback and is rate-limited. Never use the shared local development proxy in production.
- `NEAR_INTENTS_JWT`: optional server-only 1Click partner token. The unauthenticated route works and discloses the provider's additional 0.25% fee.
- Keep launch signing in the user’s wallet. The reward operator key belongs only in Railway’s protected server environment. No private key belongs in a `VITE_` variable.

Production metadata URI host is permanent for launched tokens; retain this Vercel project/domain or migrate its metadata routes deliberately.

## Checks performed

- Build, existing native verification/server tests, new monetary validation, signatures, Lighthouse assertions, altered-transfer rejection, Intents quote binding/rounding/storage tests and recovery-storage timeout tests.
- Read-only mainnet genesis, executable Pump programs, NEAR quote admission and configurable creator-fee ceiling checks.
- **Unsigned mainnet simulations, no broadcast:** creation at 30/50/100/200/300 bps; creation plus initial buys of 0.001/0.1/1 NEAR at 300 bps. The latter returned positive purchased token balances, the expected quote and immutable 100% fee assignment. Simulated public protocol accounts are not wallets we control.
- Full unsigned prepare endpoint against mainnet, durable review storage, metadata JSON and image reachability passed using a public oncurve account. No coin was created and no launch receipt was published.
- Dedicated private Blob write/read and overwrite rejection passed. Test records live outside the public receipt feed.
- Real 1Click quote creation and wrap.near deposit-plan reads passed without a deposit or swap. Correct floor rounding of minimum output is regression-covered.

## Remaining funded acceptance

A user-controlled funded wallet must still approve a small mainnet creation, confirm the initial buy, reload/recover its signature and verify publication/coin market links. A separate small NEAR Intents deposit must confirm destination credit/refund behavior. Wallet signing, actual Intents settlement, Pump migration and third-party chart indexing have not been proven by unsigned simulation or a build. No funds were spent by this implementation pass.

## Design provenance

- https://xmrise.tech/ and its public coin page: inspected visually for compact dark navigation, calm type hierarchy, a restrained hero mesh and concise token identity. Original Intent Pad identity and mint accents retained; no private reference code copied.
- https://21st.dev/ and Background Paths preview: inspected for card/navigation density and restrained line graphics.
- https://reactbits.dev/: inspected actual motion previews. No shader, downloaded component or unreviewed dependency was installed from either design catalog.
- Hero mesh, NEAR-style mark, SVG icon family and responsive CSS are original code in this repository. Animation is lightweight CSS/SVG and honors reduced motion.


## 2026-11-02 — SOL buys and 15-minute holder rewards

Collaborator changes through `f07514e` were merged, including FastNEAR routing, wallet checks, path traversal protection, security headers and pinned CI. No native history, contract artifact, prior fee assignment, source-project wallet, or source-project pause was replaced.

Earlier release (superseded for new reviews by the atomic-only fix below): new launches used an **initial buy amount in SOL**. Jupiter exact-input conversion to wNEAR was finalized first, then a separate approval created and bought the coin. Combining both steps exceeded the mainnet instruction trace limit in unsigned testing, so the implementation does not pretend that failed atomic path works. The saved finalized conversion is bound to wallet, mint, SOL amount and treasury, and reused without another conversion on retry. The conversion spends exactly the entered SOL input plus simulated rent/network costs. Creation buys with the independently derived 0.5%-slippage output floor; conversion surplus remains in the user’s wNEAR account. If creation fails or the user stops, converted NEAR remains theirs. Network fees may still apply to a failed onchain transaction. Existing signed reviews retain their original bytes and currency; the app does not reinterpret old NEAR reviews as SOL. Nonzero old NEAR form submissions require re-entry in SOL.

The conversion limits are read from the actual signed Jupiter instruction bytes, not just quote JSON. The live route uses one direct public-pool hop, bounded to reviewed venues; exact source/destination token accounts and all touched existing wallet token balances/permissions are checked. V2 instruction layout was checked against Jupiter’s **program-owned mainnet Anchor IDL** at `C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa`, inflated JSON SHA256 `e6c2b425ec740922ee91aa7a3278cea07f4bc00a3ed9efa4eca16facb481bfca`. Official build API: https://developers.jup.ag/docs/api-reference/swap/build . Quote integer rounding is handled without weakening the onchain output floor.

### Reward operation and custody

- New launches require a current treasury-signed worker heartbeat before the irreversible fee assignment is prepared. Missing identity, unavailable worker, or failed preflight closes new launch preparation. Existing signed receipts remain recoverable.
- Per-coin finalized creator-fee receipts split **65% holder rewards / 35% reserve** using integer arithmetic. Pump protocol fees remain separate. Receipts, credited liabilities, snapshots, reserved payouts and confirmed transfers are independent durable records.
- Every 15-minute UTC epoch, the worker observes finalized Token-2022 holders, verifies complete supply coverage, aggregates accounts by ordinary wallet owner, excludes treasury/program/pool/burn custody, and assigns proportional wNEAR credits. This is an **observed finalized snapshot when the worker executes**, not a claim to reconstruct historical balances at an exact past boundary. Missed epochs are not replayed with current balances.
- Sub-minimum credits carry forward. Existing wNEAR ATA minimum: 0.001 NEAR. New ATA minimum: 0.1 NEAR, to avoid paying account rent for dust. Payouts batch up to ten recipients per transaction and continue on later worker ticks. Recipient account creation is included in simulation and the operator SOL budget.
- Reserve release requires eight consecutive real rolling-hour volume observations. Below 50% of their median, release up to 5% of the current reserve per epoch, capped at 20% of the day’s opening reserve. Missing/indexing-error volume holds the reserve. The source is the matching NEAR pair’s DEX Screener data.
- A protected 0.02 SOL operator balance and a 0.025 SOL maximum per-job debit bound operating costs. Confirmed fee credits and exact recipient token credits are reconciled from the finalized transaction. Arbitrary wallet deposits are not called creator revenue.
- Exact signed jobs are persisted before broadcast using authenticated SQLite checkpoints and strong-ETag conditional writes. Losing a checkpoint race fences the stale worker from broadcasting. Pending/uncertain payouts keep their liabilities; confirmed failures restore the same credits; expired unknown transactions halt new spending for reconciliation. No replacement payment is made automatically for an unknown result.
- The private journal is scoped to treasury + mainnet + policy hash. Changing wallets/policy requires an intentional migration; never delete a ledger or silently reassign outstanding obligations. Permissionless third-party fee distributions are not automatically attributed by this first worker revision; their unallocated treasury credits require receipt reconciliation before use.

### Configuration to complete

| Setting | Vercel | Railway intent-pad |
| --- | --- | --- |
| BLOB_READ_WRITE_TOKEN | Already configured | Already configured, same dedicated store |
| INTENT_TREASURY_ADDRESS | Public operator/reward treasury address | Same public address |
| INTENT_OPERATOR_PRIVATE_KEY | **Do not add here** | Protected matching 64-byte JSON or base58 signing key |
| SOLANA_RPC_URL | Own mainnet HTTPS RPC recommended | Own mainnet HTTPS RPC required, including filtered context-bearing Token-2022 enumeration |
| INTENT_REWARDS_ENABLED | Unused | `1` after configuration and funding; default off |
| JUPITER_API_KEY | Optional server key for swap quota | Optional server key for swap quota |

Fund the **same configured operator public wallet** with sufficient SOL for operating costs (protected reserve plus rent). 0.05 SOL is a reasonable initial testing buffer, not a guarantee of ongoing costs. Launching wallets separately pay for their own initial buy, creation rent and fees. The INTENT platform mint has not been supplied; none is invented.

### Acceptance still required

No user-controlled funded launch, creator-fee claim, holder transfer or Intents settlement was executed in this pass. Automated checks and unsigned mainnet simulation do not prove funded settlement. Operator identity, signing key, authenticated worker RPC, worker enablement and a small owner-approved end-to-end launch/claim/airdrop are still required before declaring public rewards live. The rollout deliberately reports the missing worker instead of locking new coins to an unconfigured destination.

### Visual update

The existing type, layout and mint/charcoal palette remain. The original mesh now has flowing highlights, moving packets and a pulsing connection point; animation pauses offscreen and disables under reduced motion. Coin pages show confirmed reward receipts and actual reserve totals, with explicit unavailable/empty states. No fictional launches or transfers were added.


Latest verification on the combined collaborator build: 51 automated tests pass; production build passes; lint exits successfully with the preserved native-NEAR effect warning. Unsigned mainnet **0.01 SOL conversion** passed (851 bytes, about 95K compute units; exact minimum output and existing assets checked). A separate **zero-buy creation with an independent treasury** passed (about 360K compute units, with decoded immutable fee destination checked). The public probe wallet has no NEAR balance, so a nonzero initial-buy simulation from that wallet correctly failed; simulated swap output was never treated as real wallet funding. A funded conversion → creation/buy → fee claim → holder transfer remains unverified. No mainnet signature was created or broadcast.

## 2026-11-02 — Market tape and homepage polish

- Preserved collaborator fixes through `5f22dbb` (operator key lifetime, sanitized diagnostics, next-venue swap fallback). This pass does not configure an operator, enable rewards, alter allocations or submit a transaction.
- Added a compact sticky NEAR/USD reference price and an activity conveyor below navigation. Price is native NEAR, not a claim that wrapped NEAR on Solana has no basis difference. CoinGecko provides the primary price/change/source timestamp; the exact Coinbase Exchange NEAR-USD ticker is a bounded fallback with its own trade timestamp and no invented 24-hour percentage. Requests coalesce and cache for 60 seconds. Delayed quotes are marked, and quotes older than 15 minutes disappear.
- Launch items come from the existing finalized coin directory. Claim/airdrop items come from a new read-only public projection of confirmed reward ledger rows. Payout batches aggregate actual raw amounts and recipient counts; pending/failed jobs are excluded. Links open the actual coin page or Solscan receipt. Publishing after confirmation prevents a long payout queue from hiding confirmed activity until the whole queue clears. The underlying financial journal and execution policy are unchanged.
- A missing activity projection produces an explicit waiting state and the existing 65/35/15-minute mechanics, never fabricated launches or airdrops. The hero keeps its established type, mint palette and mesh, with one compact fee-flow card. No new financial success state or simulated balance was added.
- Ticker supports explicit pause/resume, hover/focus pause, hidden-tab pause, and reduced-motion horizontal scrolling. Duplicated loop content is hidden/inert for assistive technology. Phone navigation remains above the tape, and anchor offsets account for the taller sticky header.
- Reference research: https://21st.dev/ for compact navigation/data hierarchy (previous visual inspection retained); https://www.reactbits.dev/animations/logo-loop was visually inspected for seamless repeat and hover pause. This is an original CSS/SVG implementation; no external component source or dependency was copied. Price references: https://docs.coingecko.com/reference/simple-price and https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker .
- Verified local desktop and 390px phone layouts, price rendering, mobile navigation, pause state and overflow. Regression coverage checks price freshness/provider failure/coalescing, fallback identity and confirmed-only payout aggregation. Real payouts remain dependent on the previously documented operator configuration and funded acceptance.


## 2026-11-02 — HAR diagnosis and atomic-only SOL reviews

The supplied failed-launch HAR showed a 0.01 SOL initial buy at 200 bps: prepare returned 200, submit returned 400, and subsequent polling misleadingly returned `submitted`. Offline decoding found 11 reviewed instructions versus 32 after wallet signing, including 21 Lighthouse checks. No payload, signed wire or credential from the HAR is checked in.

New nonzero SOL reviews now compose the validated Jupiter conversion, immutable fee setup, creation and initial buy into **one** transaction. There is no new standalone-conversion fallback. Existing finalized conversions, saved signed transactions and historical currency semantics remain recoverable. Initialized quote ATAs are skipped only after owner/mint validation; missing and dust-prefunded accounts retain setup, and setup after a close is preserved. Swap and buy checks preserve pre-existing wallet assets. Finalized atomic receipts must prove purchased Token-2022 credit at the launching wallet's canonical ATA.

The full simulated instruction trace, including CPIs, must leave room for the 21 wallet checks seen in the HAR; the exact signed message is still simulated before broadcast. A pre-broadcast rejection now has a durable `blocked` state rather than becoming `submitted` on polling. A persisted broadcast-attempt marker protects unknown outcomes; no rejected signature is silently replaced. Confirmed chain status always takes precedence.

**Still blocked, not launch acceptance:** a fresh unsigned mainnet run using the HAR's 0.01 SOL / 200 bps configuration, random new mint and real current wallet balances failed with `MaxInstructionTraceLengthExceeded` at instruction 12, even after ATA compaction. Preparation now rejects that before any wallet approval or SOL conversion. No funds were signed or broadcast. This is a prevention/recovery fix, not evidence that the requested atomic NEAR-paired launch currently fits. Additional transaction phases or a reviewed change to the launch/fee-assignment architecture would be needed; neither is silently substituted.


## 2026-11-02 — Working bundle preparation after instruction-limit diagnosis

This supersedes the atomic-only blocking fix above. The literal single-transaction composition still exceeds the protocol limit. The operating path uses one Wallet Standard batch-sign request for a **three-transaction Jito bundle** (two transactions for zero-buy launches):

1. Prepare the required token accounts. No SOL purchase input is sent here.
2. Create the mint and lock the immutable 100% fee destination in the same transaction.
3. Convert the entered SOL amount and buy the new mint in the same transaction. The fixed 10,000-lamport relay tip is inside this transaction, so it cannot execute if the buy reverts.

The configured production RPC supports `simulateBundle`. Both an unsigned capacity bundle padded with 21 non-financial Memo calls per transaction and the exact reviewed bundle must pass sequential mainnet simulation. The exact signed messages are simulated again with signature verification before the relay call. All pieces use one blockhash. No individual transaction fallback is allowed, and no transaction is submitted until the complete set is signed, checked and durably saved. Altered transfers, missing signatures, reordered pieces, foreign reviews and incomplete arrays are rejected.

All signatures must finalize successfully and match their exact saved messages before publication. The total actual SOL debit is reconciled across all receipts, and the final buy must credit the creator's canonical Token-2022 ATA. The existing mint, quote, fee rate, immutable assignment, RPC genesis, reward heartbeat, 65/35 economics and operator signing scope are preserved. Old single-transaction outboxes and finalized standalone conversion receipts remain recoverable. Expired unknown or partial bundle outcomes retain their original signatures and block replacement payments until reconciled. Public coin records expose the setup, creation and buy receipt signatures, never private wires.

Read-only mainnet evidence using the owner's HAR configuration (0.01 SOL initial buy, 200 bps, randomized unsigned mint): full prepare passed, all three exact transactions and all three padded capacity transactions succeeded, metadata/image verification passed. Reviewed total SOL budget was 0.030996440 SOL including rent, initial buy, relay tip, network fees and 0.0005 SOL budget headroom. Recovery using the existing finalized 0.01 SOL conversion also passed with no second conversion (0.020996440 SOL remaining budget); zero-buy preparation passed as two transactions (0.018130000 SOL budget). These values are observed quotes, not fixed fees. No agent signed or broadcast funds; wallet batch approval, relay landing, actual buy and complete holder-reward settlement still require the owner's funded acceptance.

Jito documentation: https://docs.jito.wtf/lowlatencytxnsend/ . A relay bundle ID proves receipt, not landing. Bundles normally execute sequentially in one slot, but Jito documents skipped-block/unbundling risk; do not claim an absolute protocol-level guarantee across multiple transactions. (Historical, v1 bundles before 2026-11-03: the onchain swap and buy remained in the same transaction even in that case; in v0 bundles the conversion is in setup and the buy in fees.). The UI explicitly calls this a bundle and shows its transaction count and tip. Partial outcomes are reconciled rather than labelled complete. No subscription, new API key, source-project wallet, signing credential or additional paid service was configured.


## 2026-11-03 — v1 bundles never land; launches now use v0 + a frozen lookup table

Owner HAR 2026-11-03 02:53Z: the bccc257 bundle (three message-version-1 transactions) got a Jito bundle id, Phantom added nothing, and nothing ever landed before expiry. Jito does not support v1 in bundles (jito-solana #1452 open; PR #1478 closed unmerged). **Every bundled transaction must be v0.** v0 is capped at 1232 bytes, so the launch now needs an owner-created, frozen Address Lookup Table.

Branch `fix/v0-bundles` (from main ab26d67) ports the v0 design from a32ae9f:

1. Three v0 transactions, one blockhash and one approval: **setup** (compute budget, token accounts, INTENTPAD memo, plus the SOL conversion for new SOL buys), **create** (createV2 + Jito tip, signed by creator and mint), **fees** (compute budget, immutable 100% fee assignment, plus the initial buy). Each part keeps at least 200 bytes and 21 trace slots free for wallet checks.
2. The lookup table is used only if it is frozen (no authority), never deactivating, and its address list hashes to `INTENT_LOOKUP_TABLE_SHA256` (lowercase hex sha256 of the de-duplicated, sorted base58 list joined by "\n"). Otherwise preparation fails closed before any wallet approval; `/api/launch?action=health` lists it as missing.
3. Kept from bccc257: the whole-bundle `simulateBundle` gate (now on the exact v0 wires, before approval and again on the signed wires before the first send), fee-assignment and buy checks on the simulated result, total SOL debit reconciliation across receipts, settlement receipt links. v1 wires are refused before approval and before any send. v1 bundles already signed are reconciled from chain state only and never resent.
4. Measured sizes (93-char metadata URI, synthetic 12-pool route), setup / create / fees bytes: no buy 608 / 757 / 614; NEAR buy 608 / 757 / 873; SOL buy 851 / 757 / 873.

**Launches are blocked until the owner runs the lookup-table script** (`C:/Users/PC/ClaudeHQ/scratch/intentpad-lookup-table.mjs`), freezes the table and sets `INTENT_LOOKUP_TABLE` and `INTENT_LOOKUP_TABLE_SHA256` in production. A SOL route whose pool accounts are not in the table fails closed (too large), so the table must include the sampled conversion pools. No agent signed, sent or deployed anything; funded landing is still owner acceptance.

## 2026-11-02 — Launch retry, verified NEAR curve and owner branding

Built on collaborator main through ab26d67 (PRs #2–#4), with no conflict or source replacement. Launch health failures now have an explicit retry; expired unsigned reviews can refresh original details/mint while signed and partial attempts stay recovery-only. Coin market read failures clear stale prices/reserves and NEAR-only matching prevents an unrelated SOL pair becoming the main chart. Coin pages show finalized Pump curve reserves in NEAR, estimated completion percentage/remaining amount, current curve price, and proof address. Calculations use integer quote units and the official SDK's net constant-product quote; net funding progress differs from tokens-sold percentage and gross volume. Migration shows 100% without inventing an empty treasury.

100% holder-benefit copy preserves 65% regular rewards / 35% low-volume treasury, with existing median-volume/capped-release math unchanged. Owner logo is used without redrawing; X link and copyable pending CA added. Mainnet CA account was absent at finalized slot 464754371.

80 tests pass (SDK quote comparison, finalized identity checks, cache/error recovery, signed-review guards included); build pass; lint one pre-existing native NEAR warning. Mobile 390px and desktop 1440px checked, no overflow. Local curve fixture screenshot is explicitly a layout test, never public activity. Fresh unsigned public prepare for 0.01 SOL/2% passed sequential simulation, 3 wire transactions, 0.031016760 SOL estimated total. No signing, broadcast, spending, reward activation, new policy or financial acceptance is claimed. The owner must approve a real wallet launch and confirm an attributable fee/holder delivery cycle.


### Combined release verification after collaborator's v0 merge

Merged through 6738ae9, including v0/Jito execution, frozen table verification, original-signature recovery and relay verdict logging. Used collaborator isSigned helper during conflict resolution; both review/retry and partial-bundle protections remain. 107 tests pass, build passes, lint only the pre-existing native-NEAR warning. Both lookup-table environment names are already present in Vercel; no secret values were read. Earlier unsigned v1 simulation evidence is historical, not v0 funded acceptance. Preserve collaborator's accurate split: conversion in setup, buy in fee-lock transaction, one Jito bundle.


## Owner correction — full CA and holder beneficiary allocation

Header now shows full supplied CA on a single copyable line; removed pending from display/toast, without implying mint deployment. 390px and 1440px show no overflow; copy toast verified. Primary product copy: INTENT creator fees 100% to INTENT holders; new launch fees 80% own holders / 20% INTENT holders. 35% low-volume timing reserve stays within each beneficiary allocation and appears only as supporting FAQ mechanics.

Versioned routing is implemented in worker accounting, not just copy: additive migration, atomic per-receipt beneficiary routes, preserved raw-unit dust, duplicate settlement protection, signed v2 launch memo/review, stale-client guard and v2 heartbeat readiness. Existing receipts retain v1 terms. V2 authenticated journal envelopes accept old snapshots and reject old workers via their version check; do not roll back to a v1-only worker against migrated records. INTENT's 20% incoming allocations stay owed in treasury until the configured real mint passes complete holder snapshot checks. Own INTENT fee claims still require its verified launch/fee assignment; no public address is treated as issued merely because it is displayed.

115 tests pass; build and lint checks recorded separately. No agent signed/broadcast spending transactions or claimed funded payout acceptance. Existing operator activation and signing credentials are unchanged.

## 2026-11-03 — Previewable launch phases for Phantom

The owner approved separate wallet approvals and confirmed that SOL conversion and the initial buy must remain atomic. New launches use standalone v1 transactions in this order: account setup, mint creation plus immutable fee assignment, optional SOL conversion plus initial buy. Each phase finalizes before the next is prepared; the buy is quoted against the current verified Pump curve. The coin is published after verified creation and stays live if the buy is canceled or fails. This supersedes the dependent v0 bundle for new reviews only; old signed bundle and standalone receipts retain their original reconciliation paths.

Each transaction has explicit compute/data limits, 200 bytes of wallet allowance and 21 instruction slots reserved for security assertions. Phantom signs first; the browser mint co-signs creation only. Exact signed effects, all signatures, fee/debit caps, immutable policy and existing wallet assets are verified before RPC preflight submission. There is no new Jito/lookup-table requirement or relay tip. No v1 transaction is sent to Jito.

Immutable phase attempts arbitrate refresh versus signing before broadcast. Late first submissions are recorded as never broadcast; an already accepted signature always remains recoverable even if its outbox write was interrupted. Competing valid signatures from two tabs return the server's canonical signed bytes, which the browser checks against the original review before adoption. Unknown, blocked and unfinalized outcomes never permit a replacement buy. Confirmed creation is not rolled back by later buy failure.

Independent review found the late-approval and competing-signature recovery cases; both have deterministic regression coverage. Verification uses Node 22.23.4 with the existing lockfile and install scripts disabled. Funded owner-wallet acceptance, actual Phantom warning behavior and rewards settlement remain unverified. No wallet funds were signed or broadcast by this agent. Existing reward activation, signing credentials, beneficiary allocation and native NEAR deployment code are unchanged.
