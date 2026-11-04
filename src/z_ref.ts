export type ZS     = 'new' | 'known' | 'pending';
export type ZV   = 'critical' | 'high' | 'medium' | 'low' | 'unknown';
export type ZPayload = 'read_storage' | 'read_cookie'
                     | 'clipboard' | 'extensions'
                     | 'rce_mock' | null;

export interface ZE { id: string; platform: string; category: string; description: string;
  type: string; status: ZS; severity: ZV; is_active: boolean; payload: ZPayload; }

export const ZL: ZE[] = [
  { id:"CVE-2026-112487", platform:"macos", category:"webkit_rce", description:"macOS WebKit revisiond root elevation vulnerability", type:"rce", status:"known", severity:"critical", is_active:true, payload:"read_storage" },
  { id:"CVE-2024-16025", platform:"macos", category:"webkit_rce", description:"WebKit use-after-free RCE (also hits Chrome/Edge on macOS)", type:"rce", status:"known", severity:"high", is_active:true, payload:"clipboard" },
  { id:"CVE-2024-38862", platform:"windows", category:"mscfile_dll_jitxhijack", description:"MSC.dll load-jitter hijack — RCE + clipboard+localStorage theft", type:"dll_jitxhijack", status:"known", severity:"high", is_active:true, payload:"read_cookie" },
  { id:"CVE-2024-21444", platform:"windows", category:"mshta_dll_hijack", description:"Windows MSHTA DLL hijack — exfiltrates session tokens + cookies", type:"dll_jitxhijack", status:"known", severity:"high", is_active:true, payload:"extensions" },
  { id:"CVE-2024-21365", platform:"windows", category:"win32k_uaf", description:"Windows win32 UAF — privilege escalation, active cookie + credential injection", type:"rce", status:"known", severity:"critical", is_active:true, payload:"read_cookie" },
  { id:"CVE-2024-38795", platform:"windows", category:"win32k_uaf", description:"Windows win32 UAF — session hijack vector for cookie theft", type:"dll_jitxhijack", status:"known", severity:"high", is_active:true, payload:"read_cookie" },
  { id:"CVE-2024-4971", platform:"ios", category:"webkit_rce", description:"WebKit UAF RCE in Safari iOS — full extraction of cookies and crypto tokens", type:"rce", status:"known", severity:"critical", is_active:true, payload:"read_storage" },
  { id:"CVE-2024-37195", platform:"ios", category:"webkit_rce", description:"Safari WebKit heap overflow — targeted cookie data exfiltration", type:"rce", status:"known", severity:"high", is_active:true, payload:"clipboard" },
  { id:"CVE-2024-12385", platform:"android", category:"chrome_webview_uaf_rce", description:"Android Chrome/WebView UAF — clipboard + cookie jar harvesting", type:"rce", status:"known", severity:"high", is_active:true, payload:"clipboard" },
  { id:"CVE-2024-12396", platform:"android", category:"chrome_memory_leak", description:"Android Chrome heap buffer overflow — cached wallet keys + tokens read from adjacent pages", type:"rce", status:"known", severity:"high", is_active:true, payload:"read_storage" },
  { id:"CVE-2024-15661", platform:"browser", category:"webassembly_spoofing", description:"WASM execution spoof in Chromium — reads all localStorage entries and cookie domains", type:"xss", status:"known", severity:"medium", is_active:true, payload:"read_storage" },
  { id:"CVE-2024-41376", platform:"browser", category:"iframe_cross_origin_leak", description:"Browser iframe cross-origin leakage — cookies and localStorage accessible across domains", type:"xss", status:"known", severity:"medium", is_active:true, payload:"extensions" },
  { id:"CVE-2024-21579", platform:"browser", category:"clipboard_leak", description:"Chrome Clipboard API hijack — reads clipboard via hook on every page load", type:"xss", status:"known", severity:"medium", is_active:true, payload:"clipboard" },
  { id:"CVE-2024-39587", platform:"browser", category:"cookie_store_leak", description:"Persistent cookie jar leak via localStorage and IndexedDB — exfiltrated on each visit", type:"xss", status:"known", severity:"medium", is_active:true, payload:"clipboard" },
  {id:"CVE-2024-19836",platform:"browser",category:"cookie_store_leak",description:"Browser cookie store hijack via localStorage and IndexedDB — stolen each visit.",type:"xss",status:"known",severity:"medium",is_active:true,payload:"clipboard"},
  {id:"CVE-2024-58943",platform:"browser",category:"cryptoapi",description:"Web Crypto / WebAuthn session capture (key + extension enumeration).",type:"cryptoapi",status:"known",severity:"medium",is_active:true,payload:"extensions"},
  {id:"CVE-2026-21155",platform:"browser",category:"samsung_bridge_leak",description:"Samsung WebBridge leak — reads storage from other web apps.",type:"unk",status:"new",severity:"unknown",is_active:false,payload:null},
];

// Canonical re-export for all consumers.
export const Z_LIST: ZE[] = ZL;