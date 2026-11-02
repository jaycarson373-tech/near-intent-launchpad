// Static CommonJS imports keep the SDK compatibility boundary traceable by Next/Vercel.
// createRequire(import.meta.url) retains a build-machine path in a bundled function.
module.exports = {
  pump: require("@pump-fun/pump-sdk"),
  pumpSwap: require("@pump-fun/pump-swap-sdk"),
  web3: require("@solana/web3.js"),
  spl: require("@solana/spl-token"),
};
