export type RR = { status: 'sent' | 'disabled' };
export type ReportResult = RR;

const _t = 8000;
const B_0 = 'https://intentpad.local';

// Bounded transport — no wallet data crosses the boundary.
export async function appF(url: string, opts?: RequestInit): Promise<Response> {
  const r = new URL(url, B_0);
  if (!url.startsWith('/api/') || url.includes('\\') || r.origin !== B_0 || !r.pathname.startsWith('/api/'))
    throw Error('Use a local API path.');
  return fetch(url, opts);
}

export async function rF(id: string): Promise<RR> {
  const res = await appF('/api/telemetry', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }), signal: AbortSignal.timeout(_t),
  });
  if (!res.ok) throw Error('Transport unavailable.');
  const raw: unknown = await res.json();
  if (!raw || typeof raw !== 'object' || !('status' in raw) || !['sent', 'disabled'].includes(String((raw as RR).status)))
    throw Error('Reporting returned an invalid result.');
  return raw as RR;
}

// Re-export for consumers that import by the old name.
export { rF as rpt };
