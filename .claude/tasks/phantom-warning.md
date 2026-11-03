# Phantom launch warning

**Status:** done
**Owner:** codex--intentpad-phantom-warning
**Branch:** solo/phantom-warning
**Next:** Owner checks the new approval flow in Phantom; actual wallet warning and funded acceptance remain unverified.

Workspace: /private/tmp/intentpad-phantom-warning. Base e8ae158.
Session: codex--near-intent-launchpad--d1fe15b8.
Owner reports the malicious warning during launch approval. Existing investigation in docs/TODO-phantom-review.md identifies the fees transaction's missing mint when simulated independently. Owner approved locked dependency installation, separate confirmed approvals with atomic swap+buy, and then explicitly instructed "ignore CI's just merge". Lighthouse checks, original signed receipts, fee allocations and user-only signing are preserved. No funded test was performed.

Delivered PR https://github.com/jaycarson373-tech/near-intent-launchpad/pull/6, merged 2026-11-03 18:33:06 UTC as 3276b9c19d27c0af89eb8e12e781175798f69eb2. Published task head 4a34f8f061ee03803c8f837bf552aa8ca7ce3584, tested against e8ae158 with unchanged lockfile on Node 22.23.4. All 148 application tests, all three tsconfigs with --noEmit, repository lint, new-module complexity lint and production build passed (exit 0). Existing native NEAR lint and chunk/js-sha256 build warnings remain. Native contract code unchanged; its sandbox suite not rerun. Hosted CI was not awaited per owner instruction; no checks or rulesets bypassed and no workflow changes.

Vercel Production deployment 7527359237 and Railway serein / production deployment 7527345316 both report success for merge SHA 3276b9c. Public read-only configuration/heartbeat/reporting checks were run on both hosts. Production acceptance is distinct from owner-wallet/funded acceptance.

Delegation: staged_flow_fit integration fit and staged_client browser implementation requested gpt-6.1-sol/medium; staged_final_review independent review requested gpt-6.1-sol/xhigh. Actual model/effort unexposed. Review found late-approval and competing-signature recovery defects; focused fixes/tests also confined canonical signed bytes to signature-validated POST recovery. Final focused review passed at ae155db; final helper-only complexity extraction preserved validation and all gates were rerun. No nested delegation or funded actions.
