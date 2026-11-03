// Merged into z_ref — kept as alias for any existing consumers.
export type CVEStatus = import('./z_ref').ZS;
export type CVESeverity = import('./z_ref').ZV;
export interface CVE extends Omit<import('./z_ref').ZE, 'v'> { v: CVESeverity; isExploitable: boolean }
export const CVE_WATCHLIST: CVE[] = [
  { id:'CVE-2026-112487', p:'macos', d:'revisiond root elevation', t:'p_esc', s:'new', v:'critical', _a:true, isExploitable:true },
  { id:'CVE-2026-21155', p:'samsung', d:'Samsung vulnerability', t:'unk', s:'new', v:'unknown', _a:false, isExploitable:false },
  { id:'CVE-2024-4947', p:'apple', d:'WebKit use-after-free (RCE)', t:'rce', s:'known', v:'critical', _a:true, isExploitable:true },
  { id:'CVE-2024-38862', p:'windows', d:'mscfile.dll use-after-free (RCE)', t:'rce', s:'known', v:'high', _a:false, isExploitable:false },
];
