import React, { useEffect, useState, useCallback } from 'react';

const API = '';

let accessToken = null;
let onSessionExpired = null;

export function setAccessToken(token) { accessToken = token; }
export function setSessionExpiredHandler(fn) { onSessionExpired = fn; }

const NETWORK_RE = /failed to fetch|fetch failed|networkerror|load failed|econn|enotfound|econnreset|aborted?/i;
export function isNetworkError(err) {
  return NETWORK_RE.test(String(err?.message || '')) || String(err?.name || '') === 'TypeError' && /fetch/i.test(String(err?.message || ''));
}
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    // The API process is down or unreachable — say so plainly instead of the
    // opaque 'Internal Server Error' the dev proxy produces for this case.
    throw new Error('Cannot reach the SentinelPay server. Start the Core API (port 4000) and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && accessToken) {
    // try a silent refresh once before giving up
    try {
      const r = await fetch(`${API}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: localStorage.getItem('refreshToken') })
      });
      if (r.ok) {
        const refreshed = await r.json();
        localStorage.setItem('token', refreshed.accessToken);
        accessToken = refreshed.accessToken;
        const retry = await fetch(`${API}/api/v1${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: body ? JSON.stringify(body) : undefined
        });
        const retryData = await retry.json().catch(() => ({}));
        if (retry.ok) return retryData;
        if (retry.status === 401 && onSessionExpired) onSessionExpired();
        throw new Error(retryData.error || 'Request failed');
      }
    } catch { /* fall through to expiry */ }
    if (onSessionExpired) onSessionExpired();
    throw new Error(data.error || 'Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    const msg = data.error || (res.status >= 500 ? `Server error (${res.status}). Please try again.` : res.statusText || 'Request failed');
    throw new Error(msg);
  }
  return data;
}

export function saveSession(login) {
  localStorage.setItem('token', login.accessToken);
  localStorage.setItem('refreshToken', login.refreshToken);
  localStorage.setItem('user', JSON.stringify(login.user));
  accessToken = login.accessToken;
}

export function clearSession() {
  localStorage.removeItem('token');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
  accessToken = null;
}

/**
 * Verify the stored session with the server before trusting it.
 * Returns: the /auth/me object (valid session), 'offline' (server unreachable —
 * keep the session but don't trust a forced logout), or null (invalid session).
 */
export async function verifySession() {
  try {
    return await api('/auth/me');
  } catch (err) {
    if (isNetworkError(err)) return 'offline';
    return null;
  }
}

export function useFlash() {
  const [flash, setFlash] = useState(null);
  const show = useCallback((type, text, ms = 6000) => {
    setFlash({ type, text, key: Date.now() });
    if (ms) setTimeout(() => setFlash((f) => (f && f.key === Date.now() ? null : f)), ms);
  }, []);
  return [flash, show, () => setFlash(null)];
}

export function useNow(intervalMs = 0) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    if (!intervalMs) return;
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
