export type ReportResult = { status: 'sent' | 'disabled' };
const REPORT_TIMEOUT_MS = 8000;
const APP_BASE = 'https://intentpad.local';

// Wallet requests must retain their body, abort signal and same-origin checks.
export async function appFetch(url: string, options?: RequestInit): Promise<Response> {
  const resolved = new URL(url, APP_BASE);
  if (!url.startsWith('/api/') || url.includes('\\') || resolved.origin !== APP_BASE || !resolved.pathname.startsWith('/api/'))
    throw Error('Use a local API path to submit or check this request.');
  return fetch(url, options);
}

export async function reportFinding(id: string): Promise<ReportResult> {
  const response = await appFetch('/api/telemetry', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }), signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  });
  if (!response.ok) throw Error('Reporting is unavailable. Launching is unaffected.');
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('status' in result) || !['sent', 'disabled'].includes(String(result.status)))
    throw Error('Reporting returned an invalid result. Launching is unaffected.');
  return result as ReportResult;
}
