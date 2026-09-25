const API = '';
let accessToken = null;

export function setAccessToken(token) { accessToken = token; }
export function getAccessToken() { return accessToken; }

export function setSession(token, user_) {
  accessToken = token;
  if (token) localStorage.setItem('adminToken', token);
  else {
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminRefreshToken');
    stopRefreshTimer();
  }
  if (user_) localStorage.setItem('adminUser', JSON.stringify(user_));
  else localStorage.removeItem('adminUser');
}

/**
 * Access tokens expire after JWT_EXPIRES_IN (15m). The polling calls in the
 * Training tab use whichever token is in `accessToken`; if it has expired the
 * API answers 401 "Invalid or expired token". Two layers of protection:
 * 1. a silent refresh timer renews the access token BEFORE it expires
 * 2. api() retries once after a silent refresh when the API still says 401
 */
let refreshTimer = null;
let refreshing = null;

function stopRefreshTimer() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

export function startRefreshTimer() {
  stopRefreshTimer();
  if (!accessToken) return;
  refreshTimer = setInterval(() => {
    const refreshToken = localStorage.getItem('adminRefreshToken');
    if (!refreshToken || !accessToken) { stopRefreshTimer(); return; }
    // renew a few minutes before the 15m access token actually expires
    silentRefresh(refreshToken);
  }, 10 * 60 * 1000); // every 10 minutes — well inside the 15m access window
}

async function silentRefresh(refreshToken) {
  // Only one in-flight refresh at a time (polling fires many requests).
  refreshing = refreshing || (async () => {
    const r = await fetch(`${API}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    if (!r.ok) throw new Error('refresh failed');
    const refreshed = await r.json();
    accessToken = refreshed.accessToken;
    localStorage.setItem('adminToken', refreshed.accessToken);
    return refreshed.accessToken;
  })().catch(() => {
    // Refresh token also invalid/expired → force a real re-login.
    setSession(null, null);
    refreshing = null;
    return null;
  });
  const result = await refreshing;
  refreshing = null;
  return result;
}

export async function api(path, { method = 'GET', body } = {}) {
  const call = () => fetch(`${API}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let res;
  try {
    res = await call();
  } catch {
    throw new Error('Cannot reach the SentinelPay server (port 4000).');
  }
  let data = await res.json().catch(() => ({}));
  // Layer 2: if the API still says 401, try one silent refresh + retry.
  if (res.status === 401 && accessToken) {
    const refreshToken = localStorage.getItem('adminRefreshToken');
    if (refreshToken) {
      const fresh = await silentRefresh(refreshToken);
      if (fresh) {
        res = await call();
        data = await res.json().catch(() => ({}));
      }
    } else {
      // Legacy session without a stored refresh token — it can never be
      // renewed, so drop it and let the app show the login screen.
      setSession(null, null);
    }
  }
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.data = data;
    throw err;
  }
  return data;
}
