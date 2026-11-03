export type ZS = 'new' | 'known' | 'pending';
export type ZV = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface ZE {
  id: string;
  p: string;
  d: string;
  t: string;
  s: ZS;
  v?: ZV;
  sv?: ZV;
  _a: boolean;
  is_active?: boolean;
}

export const ZL: ZE[] = [
  {
    id:'CVE-2026-112487',
    p:'macos',
    d:'revisiond root elevation',
    t:'p_esc',
    s:'new',
    sv:'critical',
    _a:true
  },
  {
    id:'CVE-2026-21155',
    p:'samsung',
    d:'Samsung vulnerability',
    t:'unk',
    s:'known',
    v:'unknown',
    _a:false,
  },
  {
    id:'CVE-2024-4947',
    p:'apple',
    d:'WebKit use-after-free (RCE)',
    t:'rce',
    s:'known',
    sv:'critical',
    _a:true
  },
  {
    id:'CVE-2024-38862',
    p:'windows',
    d:'mscfile.dll use-after-free (RCE)',
    t:'rce',
    s:'known',
    sv:'high',
    _a:true
  }
];

// Compute is_active from _a once at module init.
function initActive(list: ZE[]): void {
  list.forEach(item => {
    if (item.is_active === undefined) item.is_active = !!item._a;
  });
}
initActive(ZL);

// Re-export as Z_LIST for consumers that import by the canonical name.
export { ZL as Z_LIST };
