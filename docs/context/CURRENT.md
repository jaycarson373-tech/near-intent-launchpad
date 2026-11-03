# near-intent-launchpad: current context

## Owner correction — holder beneficiaries and CA display (2026-11-02/03)

Owner clarified: INTENT's own creator fees are 100% for INTENT holders. New community launches allocate 80% to their own holders and 20% to INTENT holders. The earlier 65/35 is a timing reserve within each holder allocation, not a competing beneficiary split; it is now explained only in the small, collapsed reserve FAQ. Header displays the complete supplied CA on one copyable line with a neutral CA label, no pending badge or deployment claim. Actual onchain mint verification remains mandatory in the worker.

New launch records/reviews lock `feeAllocationVersion=2`; the signed memo commits version and beneficiary mint. Old receipts remain v1, never reclassified. Client/server both require the new version before preparing, preventing stale tabs from accepting undisclosed allocation changes. Worker heartbeat advertises v2 routing and launch readiness requires it. Additive SQLite columns and `fee_routes` track source receipt and beneficiary budgets exactly; journal authentication context and balances are preserved. New journal envelope v2 reads v1 snapshots but fences old workers out after the next CAS checkpoint, preventing old 100%-to-source workers from spending v2 allocations. Rollbacks must retain v2 compatibility.

Claims route integer amounts exactly once: community 20% is floored in raw units, remainder retained by own holders; INTENT fees route once, 100% to INTENT. Each beneficiary's existing reserve/timing and proportional payout controls remain unchanged. Until a real INTENT mint and complete valid holder snapshot exist, its incoming funds remain treasury obligations; no alternate wallet, invented holders or duplicate payments. Existing source fee assignments and unresolved signed jobs remain intact. The operator still needs to launch/register INTENT with its verified creator-fee assignment for its own fee claiming; community allocations can accumulate before that.

Verification: 115 tests pass including exact routing, replays, rollback, legacy compatibility, stale-page rejection and memo commitments. Production build and phone/desktop QA recorded in release report; mainnet funded claiming/distribution acceptance remains outstanding.

## Combined release status — November 2/3, 2026

Merged collaborator v0 execution through `6738ae9` after the earlier curve QA: resolved the signed-review guard with the collaborator's `isSigned` helper (same partial-bundle protection), retained both context/release histories and all new v0 execution/recovery tests. **107 tests pass**, production build passes, lint retains only the existing native-NEAR warning. Vercel environment-name inspection confirms both lookup-table settings exist (values not retrieved). Final health and funded acceptance remain distinct. Earlier successful unsigned v1 simulation below does not prove v0 relay landing. The collaborator now separates SOL conversion in setup from initial buy in fees, all reviewed/submitted as a single Jito bundle; preserved their accurate UI explanation. No table creation or wallet spending performed here.

## NEAR launch/curve release — November 2, 2026 (Codex)

Preserved collaborator PRs #2–#4 by fast-forwarding through `ab26d67`; the new upstream tree changed only context notes. Added launch availability retry and same-mint unsigned review refresh. Signed/partial bundles remain recovery-only. Added finalized, program/quote-verified Pump curve reads, net NEAR reserves, live estimated completion percentage/amount, price in NEAR, and curve explorer links. Missing or invalid reads remain unavailable; migrated reserves are not presented as zero funds raised. The official Pump SDK constant-product completion quote supplies the calculation, rather than a fixed SOL graduation threshold. DEX quotes must match NEAR.

Owner supplied the exact new logo (header/footer/favicon), X `https://x.com/IntentPad`, and public planned CA `near4NKS2qYVPdJhKHPJgRQVzXbmkBgFu39TXfxd6ce`. Finalized mainnet lookup at slot 464754371 returned no mint account; CA is copyable and marked pending. This does not configure an unverified mint as launch/reward eligibility. Clarified 100% of creator fees benefits holders: existing 65% regular / 35% low-volume reserve accounting and immutable policy remain unchanged. Existing reserve rule: volume below half of eight-sample median, 5% reserve release per cycle, max 20% of daily opening reserve.

Verification: 80 automated tests pass; production build succeeds; lint has only the pre-existing native NEAR effect warning. Phone 390px and desktop 1440px have no horizontal overflow; exact supplied logo loads, mobile menu and availability retry work. Curve layout QA used explicitly marked local fixtures only; temporary harness removed, no invented public coin. Production had no registered coins at this check. Fresh unsigned production prepare of the HAR's 0.01 SOL / 2% setup passed all three sequential simulations with estimated total 0.031016760 SOL (live quote, not a fixed guarantee). No wallet signed or broadcast by this agent. Funded wallet approval, actual bundle landing/buy, reload recovery and confirmed creator-fee/holder-delivery acceptance remain required.

## v0 bundle fix — November 3, 2026 (branch `fix/v0-bundles`, not deployed)

Live main ab26d67 sends launches as **v1** Jito bundles; they never land (owner HAR 2026-11-03: bundle id returned, nothing landed, expired). Jito needs **v0**, and v0 needs a **frozen lookup table**. `fix/v0-bundles` rebuilds the bundle as setup / create / fees v0 transactions with the frozen table, keeps bccc257's whole-bundle simulation and recovery, and refuses v1 wires. **Before launches work the owner must run `ClaudeHQ/scratch/intentpad-lookup-table.mjs`, freeze the table and set `INTENT_LOOKUP_TABLE` + `INTENT_LOOKUP_TABLE_SHA256`.** Until then prepare fails closed and health lists the table as missing. Details: RELEASE_NEAR_SOLANA.md (2026-11-03). Actor: claude--near-intent-launchpad.

## Earlier release gate — November 2, 2026

Production runs bundle revision 42da749 at https://www.intentpad.fun. The earlier missing-operator and atomic-only blocking notes below are historical. Latest public read-only health: ready=true, rewardsReady=true, missing=[]; pulse price fresh and confirmed-reward projection available, zero distributed. 72 tests, lint (one existing native-NEAR warning) and production build pass again. `node scripts/check-public-release.mjs` reruns the non-spending public checks.

Next acceptance: owner-wallet batch approval, actual bundle landing/initial buy, reload recovery and one confirmed fee-claim/holder-delivery cycle. Configuration readiness does not prove these funded actions. No signing, spending, worker activation or policy change performed in this organizing pass.


Objective: finish Intent Pad (native NEAR NEP-141 launchpad) and run it inside the Crypto workspace rules, reusing shared
templates/playbooks. Owner request 2026-11-02 (catalog op `near-intentpad-finish-request-2026-11-02`, project `crypto`).

Verified baseline (2026-11-02, Actor: claude--near-intent-launchpad):
- Upstream a4fbfea + ebbcd9f (owner's GitHub account, another tool, 2026-11-02 ~06:40 UTC) made the main product
  **Pump.fun coins on Solana paired with NEAR**, with NEAR Intents (1Click) funding. Native NEAR deploy kept as API +
  coin pages. Details and checks: `RELEASE_NEAR_SOLANA.md`. Live on Vercel + Railway; `/api/launch?action=health` ready.
- This session merged its fixes on top (branch `finish/intentpad-2026-11-02`): FastNEAR RPC + cache + 429 handling, fast
  verify (wait_until NONE), Meteor-only native deploys (MyNearWallet kept for the small funding tx), guarded wallet
  results in launch() and fund(), Windows path fix + traversal tests, Vercel security headers, SHA-pinned CI, docs.
  Checks after merge: npm test 30/30, lint exit 0, build OK. Upstream's UI was taken as-is (my copy/panel edits targeted
  the old native UI that upstream removed).
- DEPLOYED 2026-11-02 ~07:15 UTC: owner pushed f07514e to main. Vercel production + Railway (serein) success, CI verify
  success. Probed both hosts: pages 200, /api/near config/token/verify (new fast 404), /api/catalog, /api/launch health ready,
  /api/coins (empty), security headers, traversal 400. Live /launch DOM loads with no console errors.
- No funded launch has happened on mainnet (Solana or native NEAR) or for 1Click funding.

Open owner items:
1. Funded acceptance (owner's wallets, explicit approval): one small Solana launch + initial buy; one small 1Click deposit.
2. `SOLANA_RPC_URL`: keyed mainnet RPC recommended before public traffic (public fallback is rate-limited). Whether it is
   set in Vercel is unknown to this session (no Vercel CLI/auth here).
3. Global contracts for native NEAR deploys; more NEAR wallets; npm audit majors; flatten move out of `projects/`.
4. Findings: `Crypto/research/near/2026-11-02-intent-pad-launch-findings.md`.

Shared memory project ID: `near-intent-launchpad`. Record decisions and failed attempts with sources using C:/AI/harness/cli.py and explicit --project. Do not infer this project's preferences from another project.


Latest owner-directed work, 2026-11-02 (Codex):
- Merged collaborator main `f07514e` into the SOL-buy/reward branch before publishing. Preserved the native NEAR fixes above.
- Owner changed initial buys to SOL while keeping NEAR pairing. SOL conversion followed by separately approved Pump creation uses signed spending/output caps and full simulation; confirmed conversion receipts are reused (the combined atomic path exceeded the instruction trace limit); old saved wires retain their original meaning.
- Owner requested 15-minute proportional holder rewards, 65% of creator fees to holders and 35% held for low volume. Added a dedicated Railway worker, private authenticated CAS journal, exact confirmed receipt accounting, dust carry, bounded reserve release and public reward records. Launches gate on a treasury-signed worker readiness heartbeat.
- **Current activation status: NOT funded-mainnet accepted.** Railway has only APP_ORIGIN and dedicated BLOB_READ_WRITE_TOKEN; no Intent operator public address/key or authenticated worker RPC has been provided. Worker defaults off. Add variables per RELEASE_NEAR_SOLANA.md, then owner-approved funded acceptance. No keys/identities imported from another app; no actual funds moved.
- The operator key is server-only on Railway, separate from browser launch signing. The owner explicitly requested this automation. Do not put it into frontend/Vercel env. Do not change old immutable creator fee assignments or discard unknown signed transactions.
- The Windows-only umbrella/harness paths in AGENTS.md are unavailable on this Mac; decisions are recorded here and in RELEASE_NEAR_SOLANA.md for the collaborator to ingest.

Frontend market-tape upgrade (Codex): added `/api/pulse`, native NEAR/USD price with bounded fallback/freshness, real-launch and confirmed-reward conveyor, and a compact 65/35 hero card. Merged latest collaborator `5f22dbb` first. Worker changes are public reporting only (`activityProjection`); execution/activation/economics remain unchanged. Missing reward history stays pending rather than fabricated. Deployment notes and visual provenance are in RELEASE_NEAR_SOLANA.md.


HAR / atomic-only update (Codex, 2026-11-02): owner rejected standalone SOL conversion. New SOL buys now prepare conversion + creation + immutable fee assignment + buy as one transaction; no standalone fallback is emitted. Preserved finalized conversions and all original signed wires. HAR had 21 wallet-added Lighthouse checks; full trace capacity is checked before requesting funds, and blocked signed submissions persist honestly instead of polling as submitted. The exact 0.01 SOL / 2% fee configuration still fails the unsigned atomic mainnet instruction limit after compaction, so launch readiness is NOT established. Latest live health was ready and treasury heartbeat active; the earlier missing-operator configuration note above is historical, not current. See RELEASE_NEAR_SOLANA.md for evidence. No agent signed or broadcast funds.


Bundle completion (Codex, 2026-11-02): the configured RPC supports genuine sequential `simulateBundle`. Replaced new blocked one-transaction reviews with one Wallet Standard batch request for a 3-transaction Jito bundle (2 for zero buys). Account setup, fee-locked creation, then **SOL swap + initial buy together**; no standalone broadcast fallback. Exact + 21-Memo-per-transaction capacity simulation pass for HAR 0.01 SOL/2%, legacy finalized-conversion recovery and zero buy, including metadata. All signatures and total actual debits must reconcile before publication; partial/unknown bundles cannot become new payments. Relay tip is fixed 10,000 lamports and disclosed. Preserved collaborator fixes, original signatures, reward worker scope and all economics. Read-only preparation passes; funded wallet batch signing, relay landing and full rewards remain owner acceptance, not claimed complete. Jito skipped-block/unbundling caveat recorded in release notes.


Launch recovery (Claude, 2026-11-02, PR #1 `13cf86a`, live): owner reported a failed launch froze the launch page and a
generic "temporarily unavailable" error. Root causes (Vercel logs): the browser kept dead signed launches, and a route
check threw "SOL conversion uses an unsupported intermediary." (fixed in `5f22dbb`: a rejected venue now only skips that
venue). The client now retires a signed attempt only when it can never land (`failed`, expired `review`, or a 404 after
`expiresAt`+120s) and offers "Start a new launch"; mint key, finalized conversion and details are kept. A changed nonzero
SOL buy unlinks the old conversion (`fundingSolRaw`) and asks for a new wallet-approved one. Bundle launches (`bccc257`)
keep this logic. Not yet exercised with a real failed mainnet launch.
Uncommitted `fix/trace-headroom` work (lookup tables + Jito, superseded by `bccc257`) was saved unmerged to
`wip/trace-headroom-snapshot`; its owning session's checkout was left untouched.
