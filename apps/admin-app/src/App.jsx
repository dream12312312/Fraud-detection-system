import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, setSession, startRefreshTimer, setAccessToken } from './api.js';
import { useAdminData } from './ui.jsx';
import ArchitectureTab from './architecture/ArchitectureTab.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import TransactionsPage from './pages/TransactionsPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import PipelinePage from './pages/PipelinePage.jsx';
import TrainingPage from './pages/TrainingPage.jsx';
import DatabricksPage from './pages/DatabricksPage.jsx';
import SystemPage from './pages/SystemPage.jsx';
import InteractionsPage from './pages/InteractionsPage.jsx';
import { ShieldArt } from './illustrations.jsx';
import { ThemeToggle } from './theme.jsx';
import { AuthBackdrop } from './authbg.jsx';
import './styles.css';
import './console.css';

/* ---------- login ---------- */

function Login({ onAuth }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const login = await api('/auth/login', { method: 'POST', body: form });
      if (login.user.role !== 'admin') { setError('This console requires an admin account.'); return; }
      setSession(login.accessToken, login.user);
      localStorage.setItem('adminRefreshToken', login.refreshToken);
      startRefreshTimer();
      onAuth(login.user);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-wrap"><AuthBackdrop />
      <div className="auth-split">
        <div className="auth-side">
          <ShieldArt className="auth-art" />
          <h2>SentinelPay developer console</h2>
          <p>Operate users and payments, run the Databricks lakehouse pipeline, and train fraud models — with every status taken from the live system.</p>
          <ul>
            <li>🧭 3D architecture of the whole pipeline</li>
            <li>🧱 Databricks set-up, jobs and tables</li>
            <li>🧠 Model training with MLflow tracking</li>
          </ul>
        </div>
        <div className="auth-card">
          <div className="logo-big">🛡️</div>
          <h1>Admin Console</h1>
          <p className="sub">Sign in with an admin account</p>
          <form onSubmit={submit}>
            <div className="field">
              <label>Admin email</label>
              <input required type="email" placeholder="admin@sentinelpay.local" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="field">
              <label>Password</label>
              <input required type="password" placeholder="••••••••" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
            {error && <div className="flash error" style={{ marginBottom: 14 }}><span>⛔</span><div>{error}</div></div>}
            <button className="btn" style={{ width: '100%' }} disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
          <div className="card-hint" style={{ textAlign: 'center', marginTop: 14 }}>Credentials: ADMIN_EMAIL / ADMIN_PASSWORD in .env</div>
        </div>
      </div>
    </div>
  );
}

/* ---------- navigation ---------- */

const NAV = [
  { group: 'Overview', items: [{ id: 'overview', a: '#7c9cff', sub: 'Platform at a glance', ico: '🏠', label: 'Overview', hint: 'The platform in one screen' }] },
  { group: 'Operations', items: [
    { id: 'transactions', a: '#38bdf8', sub: 'Payments & decisions', ico: '💳', label: 'Transactions', hint: 'Payments, fraud decisions and processing paths' },
    { id: 'users', a: '#a78bfa', sub: 'Approve, credit, limits', ico: '👥', label: 'Users & money', hint: 'Approve, edit, credit/debit, limits, access' },
    { id: 'interactions', a: '#f472b6', sub: 'What people did', ico: '🗃️', label: 'User interactions', hint: 'What people did: sign-ins, payments, answers, page views (separate database)' }
  ] },
  { group: 'Data engineering', items: [
    { id: 'architecture', a: '#fbbf24', sub: '3D, in real time', ico: '🧭', label: 'Live data flow (3D)', hint: 'Every payment and pipeline run moving through the platform, live' },
    { id: 'pipeline', a: '#22d3ee', sub: 'Bronze → Silver → Gold', ico: '🌊', label: 'Data pipeline', hint: 'Landing → Bronze → Silver → Gold' },
    { id: 'training', a: '#f87171', sub: 'Train & compare models', ico: '🧠', label: 'Model training', hint: 'Choose a model + dataset, train on Databricks, compare' }
  ] },
  { group: 'Platform', items: [
    { id: 'databricks', a: '#fb923c', sub: 'Workspace & jobs', ico: '🧱', label: 'Databricks', hint: 'Workspace set-up, jobs and resources' },
    { id: 'system', a: '#34d399', sub: 'Live service checks', ico: '📡', label: 'System health', hint: 'Every service, checked live' }
  ] }
];
const ALL_TABS = NAV.flatMap((g) => g.items);

function useFlash() {
  const [flash, setFlash] = useState(null);
  const timer = useRef();
  const show = useCallback((type, text, ms = 6000) => {
    const key = Date.now();
    setFlash({ type, text, key });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash((f) => (f?.key === key ? null : f)), ms);
  }, []);
  return [flash, show, () => setFlash(null)];
}

function Dashboard({ user, onLogout }) {
  const [tab, setTabState] = useState(() => {
    const h = window.location.hash.slice(1);
    return ALL_TABS.some((t) => t.id === h) ? h : 'overview';
  });
  const [navOpen, setNavOpen] = useState(false);
  const [liveFeed, setLiveFeed] = useState([]);
  const [flash, showFlash, clearFlash] = useFlash();
  const { data: badges } = useAdminData({ stats: '/admin/stats' }, 15000);

  const setTab = (id) => {
    setTabState(id);
    setNavOpen(false);
    window.history.replaceState(null, '', `#${id}`);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    const socket = io('/', { withCredentials: true });
    socket.emit('join', { userId: user.id, role: 'admin' });
    socket.on('admin:txn', (txn) => setLiveFeed((prev) => [{ ...txn, _at: new Date().toISOString() }, ...prev].slice(0, 40)));
    socket.on('admin:alert', (a) => setLiveFeed((prev) => [{ ...a, _alert: true, _at: new Date().toISOString() }, ...prev].slice(0, 40)));
    return () => socket.disconnect();
  }, [user.id]);

  const count = { users: badges.stats?.pendingUsers, transactions: badges.stats?.challenged };
  const current = ALL_TABS.find((t) => t.id === tab);
  const group = NAV.find((g) => g.items.includes(current))?.group;
  const props = { flash: showFlash, go: setTab, liveFeed };

  return (
    <div className="app-shell shell-admin">
      <header className="topbar">
        <div className="row" style={{ gap: 10 }}>
          <button className="nav-toggle" onClick={() => setNavOpen((v) => !v)} aria-label="Menu">☰</button>
          <div className="topbar-brand"><span className="logo">🛡️</span> SentinelPay <span className="brand-sub">Developer console</span></div>
        </div>
        <div className="crumb" style={{ '--a': current?.a }}>
          <span className="crumb-ico">{current?.ico}</span>
          {group !== current?.label && <>{group} <span>›</span></>} <b>{current?.label}</b> <em>· {current?.hint}</em>
        </div>
        <div className="topbar-user">
          <span className="live-pill" title="Live transaction stream (Socket.IO)"><span className="dot pulse" /> live</span>
          <ThemeToggle />
          <span className="user-chip hide-sm" title={user.email}>
            <span className="avatar">{(user.fullName || user.email).slice(0, 2).toUpperCase()}</span>
            <span className="uc-txt"><b>{user.fullName || 'Admin'}</b><small>{user.email}</small></span>
          </span>
          <button className="btn ghost sm" onClick={() => { setSession(null, null); onLogout(); }}>Sign out</button>
        </div>
      </header>

      <div className="layout">
        {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
        <nav className={`side-nav ${navOpen ? 'open' : ''}`}>
          {NAV.map((g) => (
            <div key={g.group} className="nav-group">
              <div className="nav-label">{g.group}</div>
              {g.items.map((t) => (
                <button key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} style={{ '--a': t.a }} onClick={() => setTab(t.id)} title={t.hint} aria-current={tab === t.id ? 'page' : undefined}>
                  <span className="nav-ico">{t.ico}</span><span className="nav-text"><span>{t.label}</span><small>{t.sub}</small></span>
                  {count[t.id] > 0 && <span className="nav-count" title={t.id === 'users' ? 'users awaiting approval' : 'payments waiting for confirmation'}>{count[t.id]}</span>}
                </button>
              ))}
            </div>
          ))}
          <div className="side-foot">
            <div className="side-user">
              <div className="avatar">{(user.fullName || user.email).slice(0, 2).toUpperCase()}</div>
              <div className="who">
                <div className="name">{user.fullName || 'Admin'}</div>
                <div className="mail">{user.email}</div>
              </div>
            </div>
          </div>
        </nav>

        <main className={`main ${tab === 'architecture' ? 'wide' : ''}`}>
          {flash && (
            <div className={`flash ${flash.type} floating`} role="alert">
              <span>{{ ok: '✅', warn: '⚠️', error: '⛔', info: 'ℹ️' }[flash.type] || 'ℹ️'}</span>
              <div style={{ flex: 1 }}>{flash.text}</div>
              <button className="x" onClick={clearFlash} aria-label="Dismiss">✕</button>
            </div>
          )}
          <div className="page-in" key={tab}>
            {tab === 'overview' && <OverviewPage {...props} />}
            {tab === 'transactions' && <TransactionsPage {...props} />}
            {tab === 'users' && <UsersPage {...props} />}
            {tab === 'interactions' && <InteractionsPage {...props} />}
            {tab === 'architecture' && <ArchitectureTab lastEvent={liveFeed.find((e) => !e._alert)} />}
            {tab === 'pipeline' && <PipelinePage {...props} />}
            {tab === 'training' && <TrainingPage {...props} />}
            {tab === 'databricks' && <DatabricksPage {...props} />}
            {tab === 'system' && <SystemPage {...props} />}
          </div>
        </main>
      </div>
    </div>
  );
}

/* ---------- app root ---------- */

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('adminToken'));
  const [user, setUser] = useState(() => JSON.parse(localStorage.getItem('adminUser') || 'null'));
  const [booting, setBooting] = useState(Boolean(token));

  // When silentRefresh clears the session (e.g. the refresh token itself
  // expired), show the login screen again instead of a dead dashboard.
  useEffect(() => {
    const onStorage = () => {
      if (!localStorage.getItem('adminToken')) { setToken(null); setUser(null); }
    };
    window.addEventListener('storage', onStorage);
    const iv = setInterval(onStorage, 2000);
    return () => { window.removeEventListener('storage', onStorage); clearInterval(iv); };
  }, []);

  // Verify the stored admin session with the server before trusting it —
  // without this, a stale/expired token renders the dashboard silently.
  useEffect(() => {
    if (!token) { setBooting(false); return; }
    setAccessToken(token);
    api('/auth/me').then((me) => {
      if (me?.role !== 'admin') { setSession(null, null); setUser(null); setToken(null); }
      else { setUser(me); startRefreshTimer(); }
    }).catch(() => { setSession(null, null); setUser(null); setToken(null); })
      .finally(() => setBooting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (booting) {
    return (
      <div className="auth-wrap"><AuthBackdrop />
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <div className="logo-big">🛡️</div>
          <p style={{ color: 'var(--text-dim)' }}>Verifying admin session…</p>
        </div>
      </div>
    );
  }
  if (!user || !token) return <Login onAuth={(me) => { setToken(localStorage.getItem('adminToken')); setUser(me); }} />;
  return <Dashboard user={user} onLogout={() => { setToken(null); setUser(null); }} />;
}
