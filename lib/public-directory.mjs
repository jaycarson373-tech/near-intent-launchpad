// Owner-retired NEARCAT acceptance launches. Presentation only: retain receipts,
// metadata, immutable fee assignments, worker journals and onchain history.
export const RETIRED_TEST_MINTS = new Set([
  "5kW8wUzAoDouoY7uxBiT4mKbVXqsebtSRSHEDJ1dPR6c",
  "4LxmnZhF6gA7T4HZqhsb97aa6ALRDBtnG2jgaqF52ENe",
]);
export const isPublicLaunch = (mint) => !RETIRED_TEST_MINTS.has(mint);
export const publicActivity = (events = []) => events.filter((event) => isPublicLaunch(event.mint));
