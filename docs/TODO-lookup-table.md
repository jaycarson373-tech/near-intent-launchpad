# TODO (owner, one time): create the frozen launch lookup table

Why: launches are sent as v0 Jito bundles (Jito never lands v1 bundles). v0 transactions are capped at 1232 bytes, so the
create transaction needs a frozen address lookup table. Until it exists, `/api/launch?action=health` reports
"frozen launch lookup table" missing and launches stay closed (nothing can be spent).

Cost: about 0.0067 SOL rent (locked in the table forever) + ~0.00005 SOL fees. Any funded wallet can pay; the table is
frozen at the end, so its creator cannot change it afterwards.

## Steps (Mac or PC)
1. `git pull` (this file and `scripts/create-lookup-table.mjs` are on `main` / `fix/v0-bundles`), then `npm ci`.
2. Dry run (sends nothing):
   `node scripts/create-lookup-table.mjs`
   Expect ~35 addresses and a SHA-256 (2026-11-03 dry run: `f81f92f5889331172ee0d97f34b6dcebba96cdbb788a642e2edf0992b65f37b2`).
3. Create and freeze (run it yourself; it signs with your keypair file):
   `node scripts/create-lookup-table.mjs --execute --keypair <path to a funded Solana keypair JSON>`
   Optional faster RPC: `SOLANA_RPC_URL=<your keyed RPC> node scripts/create-lookup-table.mjs ...`
4. Copy the two PUBLIC lines it prints:
   `INTENT_LOOKUP_TABLE=...` and `INTENT_LOOKUP_TABLE_SHA256=...`
5. Set both on Vercel (project near-intent-launchpad, Production) and Railway (project serein, service intent-pad), redeploy,
   then check `https://www.intentpad.fun/api/launch?action=health` shows `"ready":true` and `"missing":[]`.
   (Or paste the two lines to Claude on the PC and it will set and verify them.)

## Prompt for Claude on the Mac
> In the near-intent-launchpad repo, `git pull` and `npm ci`, then follow `docs/TODO-lookup-table.md`: run the dry run
> (`node scripts/create-lookup-table.mjs`) and show me the address count and SHA-256. Do NOT run `--execute` yourself and do
> not read or print any keypair file: give me the exact `--execute --keypair <path>` command to run, and tell me which local
> keypair path to use if one exists (path only). After I run it, set `INTENT_LOOKUP_TABLE` and `INTENT_LOOKUP_TABLE_SHA256`
> (public values) on Vercel production and Railway (serein / intent-pad), redeploy, and confirm
> `https://www.intentpad.fun/api/launch?action=health` returns ready true with nothing missing. Do not change launch code;
> the v0 bundle fix is owned by the PC session (see docs/context/CURRENT.md and AGENTS.md "Jito bundles must use v0").
