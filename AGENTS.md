# Intent Pad (near-intent-launchpad)

Project ID: near-intent-launchpad (parent `crypto`). Root: C:/Users/PC/Projects/Crypto/projects/near-intent-launchpad
(target after the flatten: `Crypto/near-intent-launchpad`).
Upstream: https://github.com/jaycarson373-tech/near-intent-launchpad (public). `main` auto-deploys to Vercel
(https://near-intent-launchpad.vercel.app) and Railway (`intent-pad-production.up.railway.app`, project "serein").
Work on branches; pushing `main` publishes.

**Umbrella rules first:** `C:/Users/PC/Projects/Crypto/AGENTS.md` (secrets, mainnet approval, RPC cost, supply chain).
Then read `docs/context/CURRENT.md` (status briefing, not an archive). Record decisions with
`python C:/AI/harness/cli.py decision --project near-intent-launchpad ...`. Unknown stays unknown.

## What it is
Native NEAR token launchpad. Chain: NEAR (mainnet default; `VITE_NEAR_NETWORK=testnet` at build time for testnet).
Stack: Vite + React 19 + TypeScript, `@near-wallet-selector` v10 (Meteor only), Node serverless APIs `api/near.js`
(read-only RPC proxy: config, account, token, verify) and `api/catalog.js` (1Click NEAR asset directory), Railway host
`server.mjs`. The user's wallet signs ONE transaction: CreateAccount + Transfer (storage funding) + DeployContract (pinned
NEP-141 WASM from near-examples/FT, see `contracts/PROVENANCE.json`) + FunctionCall `new`. No access keys are added, so the
token contract is not upgradeable. The site holds no keys and moves no money itself; the "Intent Pad token" buyback-and-burn
economy is NOT live (no mint, collector or worker exists).

## Commands
Node 24 locally (package.json `engines` says 22.x; CI uses 22). Install from the lockfile: `npm ci`.
`npm test` · `npm run lint` · `npm run build` · `npm run dev` · `npm start` (Railway host on `dist/`).
Contract (needs Rust 1.86.0 + wasm32 target + a cargo-near host; not installed on this PC): `npm run contract:build` then
`npm run contract:test` (local near-sandbox; CI runs it on Ubuntu). npm 12 blocks install scripts for cargo-near,
near-sandbox, near-workspaces and secp256k1 unless approved; the website does not need them.

## Rules specific to this repo
- Money-moving path: `src/use-near-launch.ts` `launch()` asks the user's wallet to sign a mainnet deployment that spends
  ~2.45 NEAR of THEIR funds. Agents never sign it. A funded end-to-end test needs explicit per-action owner approval;
  prefer testnet first.
- Never change `public/contracts/fungible-token.wasm` or `lib/contract-manifest.js` by hand: the manifest's sha256/codeHash
  are what the browser and `api/near.js verify` check. Rebuild only through `contract:build` + `contract:test`.
- Launch verification is bound to the reviewed tx shape (`lib/launch-verification.js`); a draft, a wallet request or a
  pending record is never a launch.
- RPC: default keyless FastNEAR (`free.rpc.fastnear.com` / `test.rpc.fastnear.com`); `NEAR_RPC_URL_MAINNET` /
  `NEAR_RPC_URL_TESTNET` (server-only) override with a keyed provider. `rpc.*.near.org` is deprecated and throttled.
  One attempt per request; 429 → back off, never loop.
- Wallets: the deploy tx is ~270 KB+ encoded. Wallets that pass transactions in the URL (MyNearWallet → HTTP 414) cannot
  sign it. Check the transport before adding a wallet module (and ask before adding the dependency).
- Secrets are server-only; never in `VITE_*`. Never read `.env*` with real values. Raw token units are BigInt/decimal strings.
- Copy follows the machine front-end rules (`C:/Users/PC/.claude/lib/frontend-rules.md`) and
  `Crypto/shared/token-launch-credibility.md`: never pitch the buyback/burn as live until it is.
- NEAR findings and sources: `C:/Users/PC/Projects/Crypto/research/near/`.
