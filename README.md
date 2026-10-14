# Intent Pad

Native NEAR token launchpad.

## Native launch flow

Connect a named NEAR wallet, configure name/symbol/supply/decimals and a child-account prefix, review account/storage funding, then approve the transaction in the wallet. The transaction creates the child account, funds it, deploys the pinned standard NEP-141 contract and initializes the supply to the approving owner. No access keys are added to the token account. This makes the deployed contract non-upgradeable through an admin key.

The bundled WASM was built from NEAR's official FT example at the commit in contracts/PROVENANCE.json. Its SHA-256 and NEAR code hash are in public/contracts/manifest.json. The browser verifies the bytes before asking the wallet to sign. Confirmed launches require a finalized, successful owner transaction plus exact code, metadata and supply checks. Pending requests and drafts are never recorded as completed launches.

The contract account is funded for code/state storage plus a buffer; wallet gas is additional. Intent Pad charges no platform fee for native deployment in this version. It does not automatically create a liquidity pool or a new NEAR Intents route. A funded wallet deployment still requires integration verification before describing the product as launch-ready.

## Data and discovery

The public directory contains NEAR-network assets supported by 1Click. Public share links inspect a native NEAR token contract directly. Your launch list is stored on your device; it is not a global indexed registry. Native RPC endpoints are read-only and accept a fixed set of actions.

## Intent Pad token economy

100% of Intent Pad token creator fees are designated for buyback and burn. This parent-token economic mechanism is separate from native token creation and is not active until its mint/collector/worker are configured. No simulated burn receipts are published.

## Verify and deploy

`npm run lint`, `npm run test`, `npm run build`. To rebuild the contract: install Rust 1.86.0 with its wasm32 target, then `npm run contract:build` followed by `npm run contract:test`. The build uses pinned cargo-near with its required wasm-opt postprocessing. Every rebuild closes deployment configuration until the local NEAR runtime test passes; the test deploys and initializes in one transaction, verifies no administrative keys and the owner supply, registers a recipient, and transfers tokens. These are local sandbox funds, not a mainnet wallet acceptance test. Vercel: Vite preset, dist output. Node serverless api/catalog and api/near are included. Local dev and preview also mount these APIs. VITE_NEAR_NETWORK defaults to mainnet; set it to testnet at build time for a testnet deployment. Never place a private key in a browser environment variable.

The default production Vercel project is near-intent-launchpad. Vercel Git status must report a successful deployment for the current main commit before source changes can be described as published. Other projects on this account may still be blocked by the daily deployment quota.
