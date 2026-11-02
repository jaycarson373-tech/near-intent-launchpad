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
