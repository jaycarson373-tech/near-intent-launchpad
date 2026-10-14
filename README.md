# Intent Pad

NEAR-paired launch workspace. Prepare a local project brief and complete creation on StonkFun. The venue's NEAR quote token is on Solana; it is not a native NEAR token launch. Cross-chain routing is separately supported through NEAR Intents.

## Working

Live 1Click asset directory, server-side StonkFun NEAR market and pair-availability checks, persistent browser launch briefs, JSON export, and external venue handoff after the NEAR pair is confirmed launchable. Saving a brief does not mint a token; the venue does not automatically import it.

## Token economy

100% of Intent Pad's token creator fees are designated for buyback and burn. The previous holder airdrop split is removed. Fee collection and burns require a live mint, wallet and configured worker; they are not active in this release. No promise is made about fees from third-party token launches.

## Deployment

Vercel Vite preset, build `npm run build`, output `dist`; `/api/catalog` is a Node serverless endpoint. `npm run lint` and `npm run build` validate the frontend. No secrets are needed for the public market directory.
