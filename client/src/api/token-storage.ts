const ACCESS_TOKEN_STORAGE_KEY = 'balance.accessToken';

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function getAccessToken(): string | null {
  if (!canUseStorage()) {
    return null;
  }

  const value = window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
  return value && value.trim() ? value.trim() : null;
}

export function setAccessToken(token: string): void {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
}

export function clearAccessToken(): void {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
}
