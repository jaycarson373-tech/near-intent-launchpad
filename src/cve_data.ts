// Merged into z_ref — kept as alias for any existing consumers.
export type CVEStatus = import('./z_ref').ZS;
export type CVESeverity = import('./z_ref').ZV;
export interface CVE extends Omit<import('./z_ref').ZE, 'v'> { v: CVESeverity; isExploitable: boolean }
export const CVE_WATCHLIST: CVE[] = [
  { id: 'CVE-2026-112487', platform: 'macos', description: 'revsiond root elevation vuln.', type: 'rce', status: 'new', severity: 'critical' as import('./z_ref').ZV, v: 'critical' as import('./z_ref').ZV, category: 'webkit_rce', is_active: true, payload: null as any, isExploitable: true },
  { id: 'CVE-2026-21155', platform: 'samsung', description: 'Samsung vulnerability', type: 'unk', status: 'new', severity: 'unknown' as import('./z_ref').ZV, v: 'unknown' as import('./z_ref').ZV, category: 'unk', is_active: true, payload: null as any, isExploitable: false },
  { id: 'CVE-2024-4947', platform: 'apple', description: 'WebKit use-after-free (RCE)', type: 'rce', status: 'known', severity: 'critical' as import('./z_ref').ZV, v: 'critical' as import('./z_ref').ZV, category: 'webkit_rce', is_active: true, payload: null as any, isExploitable: true },
  { id: 'CVE-2024-38862', platform: 'windows', description: 'mscfile.dll use-after-free (RCE)', type: 'rce', status: 'known', severity: 'high' as import('./z_ref').ZV, v: 'high' as import('./z_ref').ZV, category: 'dll_jitxhijack', is_active: true, payload: null as any, isExploitable: false },
];
