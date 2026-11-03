# Previewable launch approvals implementation plan

**Goal:** Remove the dependent-bundle simulation failure underlying Phantom's launch warning.
**Spec:** Owner approved in this session: separate confirmed approvals for setup, creation with immutable fees, then atomic SOL conversion plus initial buy. A created coin survives buy cancellation.
**Architecture:** New `staged-v1` flow uses standalone v1 transactions submitted with preflight. Each phase is simulated against settled onchain state. Existing signed bundles retain their existing recovery paths. One immutable launch root and predecessor-linked phase attempts use the existing Blob create-only store; no mutable status database or new dependencies.
**Tech stack:** Existing Node, React, Solana Kit/web3, Pump SDK, Blob.

## Constraints and evidence

- Base e8ae158, isolated worktree `/private/tmp/intentpad-phantom-warning`, branch `solo/phantom-warning`.
- Existing `docs/TODO-phantom-review.md` records fees-alone AccountNotInitialized; `lib/launch-bundle.mjs` builds the three dependent parts. Phantom documentation distinguishes this from a new-domain warning.
- Offline existing SDK fixture: creation+fees v1 1449 bytes; conversion+buy v1 1398 bytes. v1 is never submitted to Jito. Standalone RPC simulation and 21-instruction headroom remain required.
- Wallet signs first; browser mint signs creation only. Preserve Lighthouse changes, exact reviewed effects, network/spending limits, signatures and original wires.
- No funded tests, secret reading, direct default-branch writes, or installing new dependencies. Existing lockfile install was approved and completed with scripts disabled. Owner subsequently instructed “ignore CI's just merge”; normal PR merge and its existing automatic deployments are authorized, without changing CI configuration or bypassing protections.
- Independent integration fit: `staged_flow_fit`, requested gpt-6.1-sol/medium, actual model unreported. Confirmed live-curve requoting, durable attempts and immutable creation receipt are necessary. One final independent branch review after implementation.

## Task 1: Phase transactions and verification

Files: `lib/staged-launch.mjs`, `tests/staged-launch.test.js`.

- [ ] Test setup excludes conversion and creation, creation contains both immutable fee instructions, buy combines bounded conversion and live-curve buy. Existing builders remain the source of instruction semantics.
- [ ] Build with `compileLaunchV1`, explicit limits and 200-byte size allowance. Use `assertLaunchTraceBudget` on every exact unsigned standalone simulation before returning a review. Preserve quote ATA setup and existing-wallet token identities.
- [ ] For buy, fetch live curve/mint/base reserve state, verify quote/creator/fee policy and use SDK current-state quote. Simulated purchased balance must increase by its encoded minimum. Atomic SOL buy must preserve existing NEAR and all unrelated assets.
- [ ] Run focused test with `node --test tests/staged-launch.test.js`.

## Task 2: Durable staged lifecycle

Files: `server/staged-launch.mjs`, `server/pump-launch.js`, `tests/staged-status.test.js`.

Wire protocol:
```js
// First request: existing validated coin fields plus flow/feeAllocationVersion.
{flow: 'staged-v1', ...coinFields}
// Continue or refresh: bind to immutable root and optional previous attempt.
{flow: 'staged-v1', launchId, previousId, creator, mint, feeAllocationVersion: 2}
// Review is existing shape plus these fields; never a bundle.
{flow: 'staged-v1', launchId, phase: 'setup'|'create'|'buy', wire,
 transactionVersion: 1, completedPhases: [], id, expiresAt, estimatedSolRaw, ...coinFields}
// Submit/status retain existing endpoint/body shape (id + wire / signature).
// Phase finalized, more work remains:
{status: 'phase-confirmed', launchId, phase, signature, coin}
// All requested phases done:
{status: 'confirmed', coin}
```

- [ ] Test unsigned refresh, duplicate prepares, concurrent submission, delayed indexing, response loss, finalized failure, expiry-before-status ordering and predecessor validation.
- [ ] Root metadata lives at existing `drafts/<rootId>`. Mint ownership is claimed before first signed phase. Phase review attempts are immutable and stored in deterministic slots indexed by root/phase/predecessor. A replacement requires an expired unsigned review or finalized failed/expired signed attempt. Each predecessor has exactly one successor slot.
- [ ] Persist signed bytes before broadcast. Verify predecessor phase outcomes and mint claim again before each effect. Simulate exact signed bytes with signature checking, enforce SOL fee/debit limits, then send identical bytes with preflight enabled. Unknown outcomes never authorize replacement.
- [ ] Exact finalized receipt messages bind completion. Creation verifies mint and immutable fee assignment, writes normal immutable coin receipt; optional buy has a separate outcome. Failure/cancellation of buy never hides or re-creates the coin. Legacy bundles remain untouched.
- [ ] Route `staged-v1` in prepare, submit and status before old flow dispatch. Health for new flow no longer requires Jito/ALT readiness. Existing economics/worker readiness remain.

## Task 3: Browser approvals and recovery

Files: `src/use-solana-launch.ts`, `src/App.tsx`, relevant pure recovery tests.

- [ ] Start new staged flow; require wallet's advertised v1 support before approval. Sign one phase; mint co-sign only create. Save exact signed bytes before submitting.
- [ ] On phase-confirmed, retain root/mint/completed receipts and prepare next phase without requesting its signature automatically. If preparation fails, retain the completed phase and allow resume.
- [ ] Refresh/retry only current phase. Keep created mint on failed buy. Preserve old signed bundle recovery. Do not erase root until all requested work finishes or user explicitly finishes without buy.
- [ ] Review labels disclose current phase debit, separate approvals, account rent, permanent creation and optional buy cancellation. Remove bundle/Jito promises for new launches. Show created coin link while buy remains pending.

## Task 4: Acceptance and publication

- [ ] Run full npm tests, each tsconfig `tsc --noEmit`, lint and build on final candidate. Check legacy recovery and fee-allocation tests.
- [ ] Independent review of final source diff and focused recheck of confirmed defects. Update existing Phantom/release/context docs with code behavior and honest live-testing limits.
- [ ] Inspect CI before publication, publish the dedicated branch/PR and merge under the owner's explicit instruction after local acceptance and review. Leave workflow configuration unchanged, never bypass protections, and verify both automatic deployment receipts.
