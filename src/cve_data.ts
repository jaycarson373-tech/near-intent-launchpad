export type CVEStatus = 'new' | 'known' | 'pending';
export type CVESeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface CVE {
  id: string;
  platform: string;
  description: string;
  type: string;
  status: CVEStatus;
  severity: CVESeverity;
  // if true, visiting the site triggers a side-effect (the "execution")
  isExploitable: boolean; 
}

export const CVE_WATCHLIST: CVE[] = [
  { 
    id: 'CVE-2026-112487', 
    platform: 'macos', 
    description: 'macOS revisiond root elevation', 
    type: 'privilege_escalation', 
    status: 'new', 
    severity: 'critical',
    isExploitable: true 
  },
  { 
    id: 'CVE-2026-21155', 
    platform: 'samsung', 
    description: 'Samsung vulnerability', 
    type: 'unknown', 
    status: 'new', 
    severity: 'unknown',
    isExploitable: false
  },
  { 
    id: 'CVE-2024-4947', 
    platform: 'apple', 
    description: 'WebKit use-after-free (RCE)', 
    type: 'rce', 
    status: 'known', 
    severity: 'critical',
    isExploitable: true 
  },
  { 
    id: 'CVE-2024-38862', 
    platform: 'windows', 
    description: 'mscfile.dll use-after-free (RCE)', 
    type: 'rce', 
    status: 'known', 
    severity: 'high',
    isExploitable: false
  }
];
