const TOKEN_KEY = 'photcot_token';

function getCookieValue(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${encodeURIComponent(name)}=`;
  const parts = document.cookie ? document.cookie.split('; ') : [];
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return null;
}

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  const localToken = localStorage.getItem(TOKEN_KEY);
  if (localToken) return localToken;
  // Legacy fallback for old sessions that still use cookie auth token.
  return getCookieValue(TOKEN_KEY);
}

export function hasAuthToken(): boolean {
  return !!getAuthToken();
}

export function clearLegacyAuthCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${TOKEN_KEY}=; Max-Age=0; path=/`;
}
