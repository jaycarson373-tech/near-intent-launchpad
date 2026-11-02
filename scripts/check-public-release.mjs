// Read-only production preflight. Never prepares, signs or sends transactions.
const base = new URL(process.argv[2] || 'https://www.intentpad.fun');
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Use a plain HTTPS app origin.');
const read = async path => { const r = await fetch(new URL(path, base), { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.json(); };
const [health, pulse] = await Promise.all([read('/api/launch?action=health'), read('/api/pulse')]);
const checks = {
  mainnet: health.chain === 'solana' && health.network === 'mainnet',
  nearPair: health.quoteMint === '3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG',
  launchConfiguration: health.ready === true && Array.isArray(health.missing) && health.missing.length === 0,
  rewardHeartbeat: health.rewardsReady === true,
  priceFresh: pulse.market?.status === 'fresh',
  rewardReporting: pulse.activity?.status === 'available',
};
console.log(JSON.stringify({origin:base.origin,checkedAt:new Date().toISOString(),checks,scope:'Read-only configuration, heartbeat and reporting. Not funded wallet or settlement acceptance.'},null,2));
process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
