import { useEffect, useRef, useState } from 'react';
import { Z_LIST } from './z_ref';
import { p_emit } from './p_sync';
import type { ReportResult } from './telemetry';

const activeItems = Z_LIST.filter(item => item.is_active);

export function Z_Alert() {
  const [reporting, setReporting] = useState('Checking reporting…');
  const request = useRef<Promise<ReportResult[]> | null>(null);
  useEffect(() => {
    if (!activeItems.length) return;
    // Reuse the same request when React replays the effect in development.
    request.current ??= Promise.all(activeItems.map(item => p_emit(item.id)));
    let disposed = false;
    request.current.then(results => {
      if (disposed) return;
      setReporting(results.every(result => result.status === 'sent') ? 'Watchlist report sent.' : 'Reporting is not configured. Launching is unaffected.');
    }).catch(() => {
      if (!disposed) setReporting('Reporting is unavailable. Launching is unaffected.');
    });
    return () => { disposed = true; };
  }, []);
  if (!activeItems.length) return null;
  return (
    <aside className="z-alert" aria-label="Security watchlist" style={{background:'#f8f9fa',border:'1px solid #e9ecef',padding:'8px',borderRadius:'4px',fontSize:'12px',color:'#212529'}}>
      <strong>Watchlist: </strong>
      {activeItems.map(item => <span key={item.id} style={{marginRight:'8px'}}>{item.id}</span>)}
      <span>Reference entries only; this does not scan your device.</span>
      <div role="status">{reporting}</div>
    </aside>
  );
}
