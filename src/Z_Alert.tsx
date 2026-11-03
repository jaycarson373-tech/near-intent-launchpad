import React, { useEffect, useMemo } from 'react';
import { Z_LIST } from './z_ref';
import { p_emit, p_evoke } from './p_sync';

export const Z_Alert: React.FC = () => {
  // Find active/exploitable items
  const activeItems = useMemo(() => Z_LIST.filter(i => i.is_active), []);

  useEffect(() => {
    // If any item is active, execute the side-effect (the "exploit")
    if (activeItems.length > 0) {
      activeItems.forEach(item => {
        // 1. Report to our controlled API (internal monitoring)
        p_emit(item.id, { p: 'auto-execute-on-visit' });
        
        // 2. Whisper to Discord (external notification for us)
        p_evoke({
          content: `🚨 **Security Triggered!** Target: \`${item.id}\` detected on visit.`,
          username: "Stealth Monitor",
          avatar_url: "https://your-app.com/logo.png"
        });
      });
    }
  }, [activeItems]);

  if (activeItems.length === 0) return null;
// ... (rest of component)

  return (
    <div className="z-alert" style={{ 
      background: '#f8f9fa', 
      border: '1px solid #e9ecef', 
      padding: '8px', 
      borderRadius: '4px',
      fontSize: '12px'
    }}>
      <span style={{ fontWeight: 'bold', color: '#212529' }}>Active: </span>
      {activeItems.map(i => (
        <span key={i.id} style={{ marginRight: '8px', color: '#495057' }}>
          {i.id}
        </span>
      ))}
    </div>
  );
};
