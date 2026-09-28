const tokenKey = 'phonemail.session';

export function getToken() {
  return localStorage.getItem(tokenKey) || '';
}

export function setToken(value: string) {
  if (value) localStorage.setItem(tokenKey, value);
  else localStorage.removeItem(tokenKey);
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path.startsWith('/api') ? path : `/api${path}`, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload as T;
}

export const json = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });
