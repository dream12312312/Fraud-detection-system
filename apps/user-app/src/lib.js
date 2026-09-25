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
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId(), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
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
  flushInteractions();
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

/* ---------- interaction tracking ---------- */
// Page views and clicks are queued and sent in small batches to the API, which
// stores them in the separate interaction database. Payments, answers and
// sign-ins are recorded by the server itself, so they are not sent from here.
// Only ids and small flags go in `props`, never amounts typed into forms or
// personal details.

let sid = null;
export function sessionId() {
  if (sid) return sid;
  try { sid = sessionStorage.getItem('sp-sid'); } catch { /* storage blocked */ }
  if (!sid) {
    sid = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 36);
    try { sessionStorage.setItem('sp-sid', sid); } catch { /* storage blocked */ }
  }
  return sid;
}

let queue = [];
let timer = null;

export function track(type, target, props, txId) {
  if (!accessToken) return;
  queue.push({ type, target, props, txId, ts: new Date().toISOString(), sessionId: sessionId() });
  if (queue.length >= 20) flushInteractions();
  else if (!timer) timer = setTimeout(flushInteractions, 5000);
}

export function flushInteractions() {
  clearTimeout(timer); timer = null;
  if (!queue.length || !accessToken) { queue = []; return; }
  const events = queue.splice(0, 50);
  // keepalive lets the last batch leave even while the tab is closing
  fetch(`${API}/api/v1/interactions`, {
    method: 'POST', keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId(), Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ app: 'user-app', events })
  }).catch(() => { /* analytics must never disturb the user */ });
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushInteractions(); });
}
