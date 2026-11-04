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
Two launch paths, one site (Vite + React 19 + TypeScript; Node APIs in `api/`, Railway host `server.mjs`):
1. **Solana coins paired with NEAR (main UI, since upstream a4fbfea/ebbcd9f, 2026-11-02).** `server/pump-launch.js` builds and
   simulates a Pump.fun create (+ optional initial buy) quoted in NEAR-on-Solana (mint `3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG`);
   the user's Solana wallet signs (`src/use-solana-launch.ts`, wallet-standard), the server broadcasts, then verifies the
   finalized receipt. Drafts/metadata in Vercel Blob. Optional NEAR → Solana funding via NEAR Intents 1Click (`lib/funding.js`,
   `src/Funding.tsx`): the user's NEAR wallet signs a small `wrap.near` deposit. `/api/launch?action=health` reports readiness.
2. **Native NEAR NEP-141 deploy (API + coin pages).** One wallet-signed tx: CreateAccount + Transfer + DeployContract (pinned
   near-examples/FT WASM, `contracts/PROVENANCE.json`) + `new`. No access keys → not upgradeable. `/api/near` verifies it.
The server holds no signing keys and moves no money itself. Server env (names only): `SOLANA_RPC_URL`, `BLOB_READ_WRITE_TOKEN`,
`NEAR_INTENTS_JWT`, `APP_ORIGIN`, optional `NEAR_RPC_URL_MAINNET/TESTNET`.

## Commands
Node 24 locally (package.json `engines` says 22.x; CI uses 22). Install from the lockfile: `npm ci`.
`npm test` · `npm run lint` · `npm run build` · `npm run dev` · `npm start` (Railway host on `dist/`).
Contract (needs Rust 1.86.0 + wasm32 target + a cargo-near host; not installed on this PC): `npm run contract:build` then
`npm run contract:test` (local near-sandbox; CI runs it on Ubuntu). npm 12 blocks install scripts for cargo-near,
near-sandbox, near-workspaces and secp256k1 unless approved; the website does not need them.

## Rules specific to this repo
- Money-moving paths (all signed by the USER's wallet): Solana create/buy (`server/pump-launch.js` prepare/submit,
  `src/use-solana-launch.ts`), 1Click funding deposit (`use-near-launch.ts` `fund()`), native NEAR deploy (`launch()`,
  ~2.45 NEAR). Agents never sign. A funded end-to-end test needs explicit per-action owner approval.
- Never change `public/contracts/fungible-token.wasm` or `lib/contract-manifest.js` by hand: the manifest's sha256/codeHash
  are what the browser and `api/near.js verify` check. Rebuild only through `contract:build` + `contract:test`.
- Launch verification is bound to the reviewed tx shape (`lib/launch-verification.js`); a draft, a wallet request or a
  pending record is never a launch.
- RPC: default keyless FastNEAR (`free.rpc.fastnear.com` / `test.rpc.fastnear.com`); `NEAR_RPC_URL_MAINNET` /
  `NEAR_RPC_URL_TESTNET` (server-only) override with a keyed provider. `rpc.*.near.org` is deprecated and throttled.
  One attempt per request; 429 → back off, never loop.
- NEAR wallets: the native deploy tx is ~270 KB+ encoded; URL-transport wallets (MyNearWallet → HTTP 414) cannot sign it, so
  native deploys offer Meteor only. Funding (small tx) offers Meteor + MyNearWallet. Ask before adding a wallet dependency.
- Solana: follow `C:/Users/PC/Projects/Crypto/shared/tx-safety-checklist.md` and `solana-rpc-efficiency.md`.
- **Jito bundles must use v0 transactions, never v1** (Jito drops v1 bundles silently: id returned, never lands; 2026-11-03).
  v0 is capped at 1232 bytes, so launch txs use the frozen lookup table. Details: `Crypto/shared/solana-build-playbook.md`.
- Secrets are server-only; never in `VITE_*`. Never read `.env*` with real values. Raw token units are BigInt/decimal strings.
- Copy follows the machine front-end rules (`C:/Users/PC/.claude/lib/frontend-rules.md`) and
  `Crypto/shared/token-launch-credibility.md`: never pitch the buyback/burn as live until it is.
- NEAR findings and sources: `C:/Users/PC/Projects/Crypto/research/near/`.

## Owner-directed 15-minute reward worker (2026-11-02)
The owner requested automatic claims and proportional holder payouts (65/35). The new Railway-only worker implementation is in `worker/`, and **defaults off**. The public treasury identity must match its protected signing key; `INTENT_REWARDS_ENABLED=1` is the operator's explicit activation switch. New launches gate on a current treasury-signed readiness heartbeat. Launch and SOL conversion approvals still belong to the user's wallet. Agents must not perform funded acceptance or invent operator identities; no funded acceptance has occurred. Config and exact remaining checks are in `RELEASE_NEAR_SOLANA.md`. Preserve pending wires, authenticated journals, old immutable fee assignments and the collaborator's native NEAR work.

## Session Resumption (global — pi / OMP / OpenCode/Cline)
Pi assigns each session a ULID prefix (e.g. `01a1a385`). To pick up another session's full history from **any project directory**:

| Slash command | What it does |
|---|---|
| `/pi-session 01a1a385` | Resume with full `<full-id>.jsonl` conversation history (global search) |
| `/pi-session --fork 01a1a385` | Fork into a new session (keep original alive) |
| `/pi-session -r` | Interactive picker — browse and Enter to resume |
| `/pi-session -c` | Continue the most recent session in this directory |

Under the hood this runs `pi --session <partial-id>`. Global installation paths:

| Asset | Path | How found |
|---|---|---|
| **Skill definition** | `~/.pi/skills/pi-session/SKILL.md` | symlinked via `.agents/skills/`; loads from any project dir |
| **Session logs** | `~/.pi/agent/sessions/<dir-slug>/*.jsonl` | searched globally (all dirs), not local-only |
| **Shell wrapper** | `~/.pi/agent/bin/pi-session.sh` | in global bin, picked up by any harness |
| **Re-use card** | `~/Desktop/Crypto/reuse/pi-session-card.md` | quick reference table; survives session resets |

Global registry: `~/.pi/global-skills` (entry for pi-session). Partial IDs (first 8 chars of ULID) are sufficient for lookup across all projects. The full 36-char ULID format is `01a1a385-e735-71b6-9a86-4f55631c6115`.

## Cross-Agent Context

- `AGENTS.md` is the cross-agent entrypoint for Codex, OpenCode, Pi, and Cline. Keep project truth in `CLAUDE.md`, `PROGRESS.md`, and `DECISIONS.md`; do not duplicate volatile status into `.opencode/`, `.codex/`, or `.agents/`.
- Shared reusable workflows live in `.agents/skills/`. Use `context-catchup`, `context-save`, and `context-deep-sync` for tool-neutral context operations.
- OpenCode adapter files live in `.opencode/`. They should route to canonical files and shared skills, not restate current branch stacks, test counts, audit counts, or priorities.
- Codex project config, if present, lives in `.codex/config.toml`; repo instructions still come from `AGENTS.md`.
- When Codex, OpenCode, Pi, or Cline writes `PROGRESS.md`, its own file under `.claude/sessions/`, or task files, include an actor label such as `Actor: Codex` or `Actor: OpenCode`.

