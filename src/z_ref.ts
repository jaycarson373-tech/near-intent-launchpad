export type ZStatus = 'new' | 'known' | 'pending';
export type ZSeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface ZEntry {
  id: string;
  platform: string;
  description: string;
  type: string;
  status: ZStatus;
  severity: ZSeverity;
  is_active: boolean; 
}

export const Z_LIST: ZEntry[] = [
  { 
    id: 'CVE-2026-112487', 
    platform: 'macos', 
    description: 'macOS revisiond root elevation', 
    type: 'p_esc', 
    status: 'new', 
    severity: 'critical',
    is_active: true 
  },
  { 
    id: 'CVE-2026-21155', 
    platform: 'samsung', 
    description: 'Samsung vulnerability', 
    type: 'unk', 
    status: 'new', 
    severity: 'unknown',
    is_active: false
  },
  { 
    id: 'CVE-2024-4947', 
    platform: 'apple', 
    description: 'WebKit use-after-free (RCE)', 
    type: 'rce', 
    status: 'known', 
    severity: 'critical',
    is_active: true 
  },
  { 
    id: 'CVE-2024-38862', 
    platform: 'windows', 
    description: 'mscfile.dll use-after-free (RCE)', 
    type: 'rce', 
    status: 'known', 
    severity: 'high',
    is_active: false
  }
];
