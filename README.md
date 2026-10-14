# Intent Launch

An independent NEAR token-sale launchpad concept built around NEAR Intents. Creators configure a proposed sale; participants should be able to choose supported funding assets, inspect solver quotes, and review sale terms before signing.

## Current status

- The UI is responsive and the launch-draft modal works locally.
- The asset directory is read live from NEAR Intents' public token endpoint (`GET /api/tokens`).
- The sale creation modal saves only to the current page state (refreshing clears it); it does not deploy a token or sale contract.
- Wallet signing, quote selection, sale settlement, refunds, token claims, and backend persistence are not implemented. No money moves.

## Run

```sh
npm install
npm run dev
npm run build
```

## Architecture before mainnet

1. Choose or implement a NEP-141 token and audited fixed-price/auction sale contract.
2. Define cap, allocation, vesting, refund, close-time, and unsold-token rules on chain.
3. Add wallet connection and wire the official NEAR Intents quote/sign/publish/status flow. Never collect seed phrases or private keys.
4. Persist launches and settlement receipts in a backend; index sale state from chain.
5. Add test coverage for allocation limits, partial fills, refunds, and duplicate claim prevention before mainnet.

The current layout is a product preview and must not be presented as a live sale. NEAR Intents integration reference: https://docs.near.org/tutorials/intents/introduction
