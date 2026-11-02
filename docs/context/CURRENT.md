# near-intent-launchpad: current context

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
