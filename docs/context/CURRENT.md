# near-intent-launchpad: current context

Objective: finish Intent Pad (native NEAR NEP-141 launchpad) and run it inside the Crypto workspace rules, reusing shared
templates/playbooks. Owner request 2026-11-02 (catalog op `near-intentpad-finish-request-2026-11-02`, project `crypto`).

Verified baseline (2026-11-02, Actor: claude--near-intent-launchpad):
- Live: https://near-intent-launchpad.vercel.app and `intent-pad-production.up.railway.app` serve commit d7769c8
  (GitHub status: Vercel + Railway success, CI `verify` success). Site, `/api/near?action=config`, `/api/catalog`,
  Railway `/health` answered 200.
- No funded end-to-end launch on record (testnet or mainnet). The contract passed only the local near-sandbox test.
- The Intent Pad token and its buyback-and-burn economy do not exist yet.

Uncommitted work on `main` (local only, not pushed; pushing `main` deploys):
- RPC: FastNEAR keyless defaults + `NEAR_RPC_URL_MAINNET/TESTNET` override; storage price cache; 429 handling.
- Verify: `tx` with `wait_until: NONE` (FINAL hung >30 s on unknown hashes), unknown → 404, not FINAL → 409 retry;
  client retries 8 × 2 s.
- Wallets: MyNearWallet removed (HTTP 414 on the ~270 KB deploy tx); Meteor only. Pending launch recovery by tx hash.
- UI: buyback/burn tagged NOT LIVE; copy cut per front-end rules; BigInt supply display.
- Server: Windows path-containment fix; Vercel security headers; CI actions SHA-pinned.
- Onboarding: AGENTS.md, CLAUDE.md, .env.example, .gitignore baseline, registered as `near-intent-launchpad` (parent crypto).
- Checks: `npm test` 19/19, lint 0 errors (3 pre-existing warnings), build OK; browser checked at desktop and 390 px.
- Independent review (opus): no blockers; should-fix applied (a new launch no longer overwrites an unverified pending one);
  notes applied: saved hash pre-filled, verify stops on 503, sibling-directory traversal test, clearer unknown-hash text.
- Findings and sources: `Crypto/research/near/2026-11-02-intent-pad-launch-findings.md`.

Open owner decisions:
1. Commit + push to `main` (deploys to Vercel and Railway).
2. Funded testnet launch with Meteor (testnet build `VITE_NEAR_NETWORK=testnet`), then a small mainnet launch: both
   need explicit per-action approval and the owner's own wallet.
3. More wallets (HOT, Intear, Sender…): new dependencies; check each transport for the ~270 KB limit first.
4. Global contracts (NEP-591): deploy the FT WASM once (~20 NEAR burned) so each launch costs < 0.1 NEAR and fits any
   wallet. Wallet-selector 10.1.4 / Meteor SDK show no `useGlobalContract` support yet.
5. Move repo to `Crypto/near-intent-launchpad` (flatten script) when no session has it open.
6. npm audit: 29 advisories (9 high), mostly dev/optional (cargo-near, near-workspaces) and Meteor's nanoid; fix needs
   major bumps — review separately.

Shared memory project ID: `near-intent-launchpad`. Record decisions and failed attempts with sources using C:/AI/harness/cli.py and explicit --project. Do not infer this project's preferences from another project.
