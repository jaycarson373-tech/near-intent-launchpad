# Intent Pad — NEAR-paired Solana release

## Scope and preserved state

The product now launches Pump.fun tokens on **Solana mainnet**, paired with wrapped NEAR (`3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG`, 9 decimals, SPL Token). The mint was checked against Pump's live QuoteControl. Native NEAR creation is no longer the primary UI. The pinned native contract, verification API, sandbox tests and browser receipt namespaces remain unchanged; earlier `?token=...` links still inspect the native token on NEAR.

The creation flow reuses PennyFun's official-SDK creation, immutable fee-sharing assignment, v1 wire encoding, wallet assertion validation and receipt recovery. Source revision: `b633d40af60f1aa1d7e24c63d5d8d6340913c054`. No Penny wallet, provider credential, ledger, paused worker or stock economics were imported. Creator-fee choices are 0.3%, 0.5%, 1%, 2%, 3%; **100% of each launched coin's creator fees belong to its launching wallet**. Pump protocol fees are separate. The previous, separate parent Intent Pad buyback/burn proposal remains unconfigured and inactive; this release does not activate it.

## Implementation

- Wallet Standard Solana connection; wallet-approved launch and optional exact-input wNEAR buy in one transaction. No operator private key or server-side mint key.
- Non-extractable browser mint CryptoKey, wallet-specific IndexedDB draft and exact signed-wire recovery. A signed, unresolved transaction never silently becomes a new mint or a second payment.
- Private, dedicated Vercel Blob store: immutable reviews and signed outbox, then public receipt projection only after finalized successful transaction, message equality, mint and locked fee validation. Signed wires remain private.
- NEAR Intents / 1Click funding to the connected Solana wallet: exact recipient, assets, refund account, input and 1% slippage bound. Sender/receiver storage, only necessary wrapping, exact wNEAR transfer. Funding is a distinct NEAR wallet approval. A provider status is not treated as a confirmed wallet balance.
- A read-only directory refresh reconciles saved pending signatures, so confirmed launches can be published even after their creator closes the browser. It never broadcasts another transaction. Confirmed launch directory, persistent per-mint coin pages, creator wallet and transaction links, Pump market link. DEX Screener chart and figures only for a matching Solana token/pair; pending indexing has an explicit state.
- Mainnet genesis and Pump program checks; image byte/type/size validation; metadata and image public reachability before approval; signed-message, fee and reviewed SOL budget checks before broadcast.

## Required production configuration

Vercel project: `near-intent-launchpad`. No Supabase database or Railway worker is needed for this wallet-signed flow.

- `BLOB_READ_WRITE_TOKEN`: server-only; linked to the dedicated private `intent-pad-launches` store. Already configured in production.
- `APP_ORIGIN`: optional canonical HTTPS origin; otherwise Vercel production URL is used. Must match the live site used for wallet reviews/metadata.
- `SOLANA_RPC_URL`: server-only authenticated mainnet RPC recommended before public traffic. Public Solana mainnet RPC is the fallback and is rate-limited. Never use the shared local development proxy in production.
- `NEAR_INTENTS_JWT`: optional server-only 1Click partner token. The unauthenticated route works and discloses the provider's additional 0.25% fee.
- Keep all signing in the user's wallets. No private key belongs in a `VITE_` variable.

Production metadata URI host is permanent for launched tokens; retain this Vercel project/domain or migrate its metadata routes deliberately.

## Checks performed

- Build, existing native verification/server tests, new monetary validation, signatures, Lighthouse assertions, altered-transfer rejection, Intents quote binding/rounding/storage tests and recovery-storage timeout tests.
- Read-only mainnet genesis, executable Pump programs, NEAR quote admission and configurable creator-fee ceiling checks.
- **Unsigned mainnet simulations, no broadcast:** creation at 30/50/100/200/300 bps; creation plus initial buys of 0.001/0.1/1 NEAR at 300 bps. The latter returned positive purchased token balances, the expected quote and immutable 100% fee assignment. Simulated public protocol accounts are not wallets we control.
- Full unsigned prepare endpoint against mainnet, durable review storage, metadata JSON and image reachability passed using a public oncurve account. No coin was created and no launch receipt was published.
- Dedicated private Blob write/read and overwrite rejection passed. Test records live outside the public receipt feed.
- Real 1Click quote creation and wrap.near deposit-plan reads passed without a deposit or swap. Correct floor rounding of minimum output is regression-covered.

## Remaining funded acceptance

A user-controlled funded wallet must still approve a small mainnet creation, confirm the initial buy, reload/recover its signature and verify publication/coin market links. A separate small NEAR Intents deposit must confirm destination credit/refund behavior. Wallet signing, actual Intents settlement, Pump migration and third-party chart indexing have not been proven by unsigned simulation or a build. No funds were spent by this implementation pass.

## Design provenance

- https://xmrise.tech/ and its public coin page: inspected visually for compact dark navigation, calm type hierarchy, a restrained hero mesh and concise token identity. Original Intent Pad identity and mint accents retained; no private reference code copied.
- https://21st.dev/ and Background Paths preview: inspected for card/navigation density and restrained line graphics.
- https://reactbits.dev/: inspected actual motion previews. No shader, downloaded component or unreviewed dependency was installed from either design catalog.
- Hero mesh, NEAR-style mark, SVG icon family and responsive CSS are original code in this repository. Animation is lightweight CSS/SVG and honors reduced motion.
