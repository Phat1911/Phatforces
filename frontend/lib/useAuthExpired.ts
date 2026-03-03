'use client';
import { useState, useEffect } from 'react';

/**
 * Shared hook: listens for the photcot:auth-expired event dispatched by
 * the axios interceptor in lib/api.ts whenever a 401 is received.
 * Use this on any page that makes API calls so the AuthModal can appear.
 */
export function useAuthExpired() {
  const [showAuth, setShowAuth] = useState(false);

  useEffect(() => {
    const handler = () => setShowAuth(true);
    window.addEventListener('photcot:auth-expired', handler);
    return () => window.removeEventListener('photcot:auth-expired', handler);
  }, []);

  return { showAuth, setShowAuth };
}
