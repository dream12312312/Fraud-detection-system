import React, { useEffect, useState, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { api, saveSession, clearSession, verifySession, setAccessToken, setSessionExpiredHandler, useNow, track } from './lib.js';
import { PaymentJourney, ProtectionStrip } from './journey.jsx';
import { PipelineArt } from './illustrations.jsx';
import './pages.css';
import { ThemeToggle } from './theme.jsx';
import { AuthBackdrop } from './authbg.jsx';
import { MoneyChart, WhereMoneyWent, RiskMap, SignalPreview } from './charts.jsx';
// note: the component-local useFlashSafe below replaces lib.js's useFlash so the
// flash timer is cancellable (avoids an older flash wiping a newer one)

/* ---------- helpers ---------- */

const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const timeAgo = (iso) => {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

function Flash({ flash, onClose }) {
  if (!flash) return null;
  const icons = { ok: '✅', warn: '⚠️', error: '⛔', info: 'ℹ️', fraud: '🚨' };
  return (
    <div className={`flash ${flash.type}`} role="alert">
      <span>{icons[flash.type] || 'ℹ️'}</span>
      <div style={{ flex: 1 }}>{flash.text}</div>
      <button className="btn ghost sm" onClick={onClose} aria-label="Dismiss">✕</button>
    </div>
  );
}

function Empty({ icon, title, text }) {
  return (
    <div className="empty">
      <div className="icon">{icon}</div>
      <h4>{title}</h4>
      <p>{text}</p>
    </div>
  );
}

const RiskBadge = ({ level, prob }) => {
  if (!level && prob == null) return <span style={{ color: 'var(--text-faint)' }}>—</span>;
  const cls = level === 'HIGH' ? 'HIGH' : level === 'MEDIUM' ? 'MEDIUM' : 'LOW';
  return <span className={`badge ${cls}`}>{level || 'LOW'} {prob != null ? `· ${Math.round(prob * 100)}%` : ''}</span>;
};

/* ---------- auth screens ---------- */

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ fullName: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingEmail, setPendingEmail] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (mode === 'register') {
        const r = await api('/auth/register', { method: 'POST', body: form });
        setPendingEmail(r.email);
        setMode('pending');
      } else {
        const login = await api('/auth/login', { method: 'POST', body: { email: form.email, password: form.password } });
        saveSession(login);
        onAuth(login.user);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'pending') {
    return (
      <div className="auth-wrap"><AuthBackdrop />
        <div className="auth-card">
          <div className="logo-big">🛡️</div>
          <h1>Almost there</h1>
          <p className="sub">Your account for <b>{pendingEmail}</b> is created and is awaiting administrator approval.</p>
          <div className="pending-box">
            <div className="icon">⏳</div>
            <ul className="pending-steps">
              <li className="done">Registration complete</li>
              <li className="done">Account created with a $5,000 demo balance</li>
              <li className="current">Waiting for admin approval</li>
              <li>Sign in and start banking</li>
            </ul>
            <p style={{ color: 'var(--text-faint)', fontSize: 13 }}>You will be able to sign in once your account is approved.</p>
          </div>
          <button className="btn ghost auth-switch" onClick={() => { setMode('login'); setError(''); }}>← Back to sign in</button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap"><AuthBackdrop />
      <div className="auth-card">
        <div className="logo-big">🛡️</div>
        <h1>SentinelPay</h1>
        <p className="sub">{mode === 'login' ? 'Sign in to your online banking' : 'Open a demo account in seconds'}</p>
        <form onSubmit={submit}>
          {mode === 'register' && (
            <div className="field">
              <label>Full name</label>
              <input required placeholder="Ada Lovelace" value={form.fullName} onChange={set('fullName')} />
            </div>
          )}
          <div className="field">
            <label>Email</label>
            <input required type="email" placeholder="you@example.com" value={form.email} onChange={set('email')} />
          </div>
          <div className="field">
            <label>Password</label>
            <input required type="password" placeholder={mode === 'register' ? 'At least 8 characters' : '•'} value={form.password} onChange={set('password')} />
            {mode === 'register' && <div className="hint">Demo accounts start with a $5,000 balance pending approval.</div>}
          </div>
          {error && <div className="flash error" style={{ marginBottom: 14 }}><span>⛔</span><div>{error}</div></div>}
          <button className="btn" style={{ width: '100%' }} disabled={busy} type="submit">
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <button className="btn ghost auth-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? "New to SentinelPay? Create an account" : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}

/* ---------- dashboard ---------- */

const NAV = [
  { group: 'Money', items: [
    { id: 'overview', a: '#7c9cff', sub: 'Balance & activity', ico: '🏠', label: 'Overview', hint: 'Balances and recent activity' },
    { id: 'transfer', a: '#34d399', sub: 'Pay someone', ico: '💸', label: 'Send money', hint: 'Send money to a payee' },
    { id: 'beneficiaries', a: '#a78bfa', sub: 'Saved people', ico: '👥', label: 'Payees', hint: 'Saved payees for faster, lower-risk transfers' }
  ] },
  { group: 'Activity & security', items: [
    { id: 'transactions', a: '#38bdf8', sub: 'History & checks', ico: '🧾', label: 'Transactions', hint: 'History with how each payment was checked' },
    { id: 'notifications', a: '#fbbf24', sub: 'Security notices', ico: '🔔', label: 'Alerts', hint: 'Security and account notifications' }
  ] }
];

function SideNav({ user, tab, setTab, unread, challenged, onLogout }) {
  const initials = (user_) => (user_.fullName || user_.email).split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <nav className="side-nav">
      {NAV.map((g) => (
        <div key={g.group} className="nav-group">
          <div className="nav-label">{g.group}</div>
          {g.items.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${tab === t.id ? 'active' : ''}`}
              style={{ '--a': t.a }}
              onClick={() => setTab(t.id)}
              title={t.hint}
              aria-label={`${t.label} — ${t.hint}`}
              aria-current={tab === t.id ? 'page' : undefined}
            >
              <span className="nav-ico">{t.ico}</span><span className="nav-text"><span>{t.label}</span><small>{t.sub}</small></span>
              {t.id === 'notifications' && unread > 0 && <span className="nav-count" title={`${unread} unread notifications`}>{unread}</span>}
              {t.id === 'transactions' && challenged && <span className="nav-dot" title="A transaction needs your confirmation" />}
            </button>
          ))}
        </div>
      ))}
      <div className="side-foot">
        <div className="side-user">
          <div className="avatar" aria-hidden="true">{initials(user)}</div>
          <div className="who">
            <div className="name">{user.fullName || user.email}</div>
            <div className="mail">{user.email}</div>
          </div>
        </div>
        <button className="btn ghost sm" style={{ width: '100%', marginTop: 8 }} onClick={onLogout}>Sign out</button>
      </div>
    </nav>
  );
}

export default function App() {
  const [user, setUser] = useState(() => JSON.parse(localStorage.getItem('user') || 'null'));
  const [booting, setBooting] = useState(true);

  // restore + verify session on load
  useEffect(() => {
    const stored = localStorage.getItem('token');
    if (!stored) { setBooting(false); return; }
    setAccessToken(stored);
    verifySession().then((me) => {
      if (me) {
        localStorage.setItem('user', JSON.stringify(me));
        setUser(me);
      } else {
        clearSession();
        setUser(null);
      }
      setBooting(false);
    });
  }, []);

  if (booting) {
    return (
      <div className="auth-wrap"><AuthBackdrop />
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <div className="logo-big">🛡️</div>
          <p style={{ color: 'var(--text-dim)' }}>Loading SentinelPay…</p>
        </div>
      </div>
    );
  }
  if (!user) return <AuthScreen onAuth={setUser} />;
  // An admin-issued temporary password MUST be changed before banking.
  if (user.mustChangePassword) {
    return (
      <ChangePasswordScreen
        user={user}
        onDone={(updated) => { localStorage.setItem('user', JSON.stringify(updated)); setUser(updated); }}
        onLogout={() => { clearSession(); setUser(null); }}
      />
    );
  }
  return <Shell user={user} onUser={setUser} onLogout={() => { clearSession(); setUser(null); }} />;
}

/* ---------- forced temporary-password change ---------- */

function ChangePasswordScreen({ user, onDone, onLogout }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.newPassword !== form.confirm) { setError('The two new passwords do not match.'); return; }
    setBusy(true);
    try {
      const r = await api('/auth/change-password', { method: 'POST', body: { currentPassword: form.currentPassword, newPassword: form.newPassword } });
      onDone({ ...user, mustChangePassword: false });
      alert(r.message || 'Password updated.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-wrap"><AuthBackdrop />
      <div className="auth-card">
        <div className="logo-big">🔐</div>
        <h1>Set your own password</h1>
        <p className="sub">You are signed in with a <b>temporary password</b> created by an administrator. Choose your own password now — you cannot use SentinelPay until you do.</p>
        <form onSubmit={submit}>
          <div className="field">
            <label>Temporary password</label>
            <input required type="password" value={form.currentPassword} onChange={set('currentPassword')} />
          </div>
          <div className="field">
            <label>New password</label>
            <input required type="password" minLength={8} placeholder="At least 8 characters" value={form.newPassword} onChange={set('newPassword')} />
          </div>
          <div className="field">
            <label>Confirm new password</label>
            <input required type="password" minLength={8} value={form.confirm} onChange={set('confirm')} />
          </div>
          {error && <div className="flash error" style={{ marginBottom: 14 }}><span>⛔</span><div>{error}</div></div>}
          <button className="btn" style={{ width: '100%' }} disabled={busy} type="submit">{busy ? 'Saving…' : 'Save new password'}</button>
        </form>
        <button className="btn ghost auth-switch" onClick={onLogout}>Sign out instead</button>
      </div>
    </div>
  );
}

function Shell({ user, onUser, onLogout }) {
  const [tab, setTab] = useState('overview');
  const [flash, flashMsg, clearFlash] = useFlashSafe();
  const [focus, setFocus] = useState(null);
  const [payTo, setPayTo] = useState(null);
  const [data, setData] = useState({ accounts: [], txns: [], notifs: [], beneficiaries: [] });
  const [loading, setLoading] = useState(true);
  const socketRef = useRef(null);
  const [live, setLive] = useState(null); // real Socket.IO connection state; null until the first answer
  const now = useNow(30000); // re-render clock for "x ago" labels

  const load = useCallback(async () => {
    try {
      const [accounts, txns, notifs, beneficiaries] = await Promise.all([
        api('/accounts'), api('/transactions?limit=200'), api('/notifications'), api('/beneficiaries')
      ]);
      setData({ accounts, txns, notifs, beneficiaries });
    } catch (err) {
      flashMsg('error', err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { track('page.view', tab); }, [tab]);

  // live updates over socket.io
  useEffect(() => {
    setSessionExpiredHandler(() => { clearSession(); onLogout(); });
    const socket = io('/', { withCredentials: true });
    socketRef.current = socket;
    socket.on('connect', () => setLive(true));
    socket.on('disconnect', () => setLive(false));
    socket.on('connect_error', () => setLive(false));
    socket.emit('join', { userId: user.id });
    socket.on('transaction:update', () => { load(); });
    socket.on('notification:new', (n) => {
      setData((d) => ({ ...d, notifs: [n, ...d.notifs].slice(0, 50) }));
      const kind = n.type === 'FRAUD_ALERT' ? 'fraud' : n.type === 'WARNING' ? 'warn' : n.type === 'SUCCESS' ? 'ok' : 'info';
      flashMsg(kind, <span><b>{n.title}</b>{n.body ? ` — ${n.body}` : ''}</span>, 8000);
      if (n.type === 'WARNING') load(); // a challenge may have appeared
    });
    return () => socket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  const goTab = (t) => { setFocus(null); setPayTo(null); setTab(t); };
  // Quick pay / "Pay" on a payee card: open Send money with that payee picked
  const payTo_ = (acct) => { track('ui.quick_pay', tab); setFocus(null); setPayTo(acct); setTab('transfer'); };
  // open one payment in Transactions (its full journey), without counting it as a review
  const openTx = (t) => { setFocus(t._id); setTab('transactions'); };
  const reviewing = data.txns.find((t) => t.status === 'CHALLENGED');
  // "Review" opens the payment itself in Transactions, where its verdict carries the answer buttons
  const openReview = (tx) => { const t = tx?.txId ? tx : reviewing; if (t) { track('ui.review_open', tab, { from: tx?.txId ? 'alert' : 'banner' }, t.txId); setFocus(t._id); setTab('transactions'); } };

  // the customer's answer to a payment the fraud engine sent for confirmation
  const decide = async (tx, kind) => {
    try {
      const r = await api(`/transactions/${tx.txId}/${kind}`, { method: 'POST' });
      if (kind === 'report') flashMsg('info', `Payment ${tx.txId} reported as fraud and stopped. No money left your account.`);
      else if (r.status === 'COMPLETED') flashMsg('ok', `Payment ${tx.txId} confirmed and sent.`);
      else flashMsg('warn', `Payment ${tx.txId} could not be sent (${r.status.toLowerCase()}).`);
    } catch (err) {
      flashMsg('error', err.message);
    }
    await load();
  };

  const checking = data.accounts.find((a) => a.type === 'CHECKING');
  const savings = data.accounts.find((a) => a.type === 'SAVINGS');
  const unread = data.notifs.filter((n) => !n.read).length;


  return (
    <div className="app-shell shell-user">
      <header className="topbar">
        <div className="topbar-brand"><span className="logo">🛡️</span> SentinelPay</div>
        <div className="topbar-user">
          <ThemeToggle />
          <span className="user-chip" title={live === false ? 'Live updates disconnected — reconnecting' : live ? 'Live updates connected' : 'Connecting…'}>
            <span className="avatar">{(user.fullName || user.email).split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}<i className={live ? 'ok' : live === false ? 'bad' : ''} /></span>
            <span className="uc-txt"><b>{user.fullName || user.email}</b><small>{live ? 'Live updates on' : live === false ? 'Reconnecting…' : 'Connecting…'}</small></span>
          </span>
          <button className="btn ghost sm" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <div className="layout">
        <SideNav user={user} tab={tab} setTab={goTab}unread={unread} challenged={Boolean(reviewing)} onLogout={onLogout} />
        <main className="main">
          <Flash flash={flash} onClose={clearFlash} />

          <div className="page-in" key={tab}>
            {tab === 'overview' && (
              <OverviewTab user={user} checking={checking} savings={savings} txns={data.txns} beneficiaries={data.beneficiaries} notifs={data.notifs} loading={loading} go={goTab} onReview={openReview} onOpen={openTx} onPay={payTo_} />
            )}
            {tab === 'transfer' && <TransferTab data={data} user={user} flashMsg={flashMsg} reload={load} onDecide={decide} payTo={payTo} go={goTab} />}
            {tab === 'transactions' && <TxnTab txns={data.txns} beneficiaries={data.beneficiaries} loading={loading} onDecide={decide} focus={focus} />}
            {tab === 'beneficiaries' && <BeneficiaryTab data={data} flashMsg={flashMsg} reload={load} onPay={payTo_} />}
            {tab === 'notifications' && <NotifTab notifs={data.notifs} txns={data.txns} reload={load} now={now} onReview={openReview} />}
          </div>
        </main>
      </div>
    </div>
  );
}

/* useFlash with stable identity (re-export wrapper to keep deps tidy) */
function useFlashSafe() {
  const [flash, setFlash] = useState(null);
  const timer = useRef();
  const show = useCallback((type, text, ms = 6000) => {
    const key = Date.now();
    setFlash({ type, text, key });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash((f) => (f && f.key === key ? null : f)), ms);
  }, []);
  return [flash, show, () => setFlash(null)];
}

/* ---------- shared bits for the tabs ---------- */

const initials = (s) => (s || '?').split(/[\s(]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
/** A stable colour per name, so a payee keeps its colour everywhere. */
const hueOf = (s) => [...(s || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 17);
function Avatar({ name, size = 38 }) {
  const h = hueOf(name);
  return <span className="u-av" style={{ width: size, height: size, fontSize: size * 0.36, background: `linear-gradient(135deg, hsl(${h} 75% 58%), hsl(${(h + 40) % 360} 70% 48%))` }}>{initials(name)}</span>;
}
const payeeOf = (t, bens) => bens.find((b) => String(b._id) === String(t.beneficiaryId));
const txName = (t, bens) => (t.type === 'DEPOSIT' ? (t.adminNote || 'Deposit') : payeeOf(t, bens)?.nickname || t.merchant || 'Transfer');
const isOut = (t) => t.type !== 'DEPOSIT';
const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const dayLabel = (iso) => {
  const d = new Date(iso); const t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1);
  if (dayKey(d) === dayKey(t)) return 'Today';
  if (dayKey(d) === dayKey(y)) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};
const clock = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const STATUS_LABEL = { COMPLETED: 'Completed', CHALLENGED: 'Needs you', BLOCKED: 'Blocked', PENDING_RISK_CHECK: 'Checking', FAILED: 'Failed', EXPIRED: 'Expired' };
const Tag = ({ status }) => <span className={`badge ${status}`}>{STATUS_LABEL[status] || status.replace(/_/g, ' ')}</span>;

/** One payment as an app-style row: who, what, when, how much, outcome. */
function ActivityRow({ t, bens, onClick, active }) {
  const name = txName(t, bens);
  return (
    <button type="button" className={`u-act ${t.status} ${active ? 'on' : ''}`} onClick={onClick}>
      <Avatar name={name} size={36} />
      <span className="u-act-main">
        <b>{name}{t.merchant && payeeOf(t, bens) ? <em> · {t.merchant}</em> : null}</b>
        <span>{dayLabel(t.createdAt)} · {clock(t.createdAt)}<span className="u-txid"> · <span className="mono">{t.txId}</span></span></span>
      </span>
      <span className="u-act-right">
        <b className={`amount ${isOut(t) ? '' : 'in'} ${t.status === 'BLOCKED' ? 'struck' : ''}`}>{isOut(t) ? '−' : '+'}{money(t.amount)}</b>
        <Tag status={t.status} />
      </span>
    </button>
  );
}

/* ---------- overview ---------- */

/** The "how it works" explainer, collapsed by default for returning users so the
 * page opens on real activity instead of onboarding copy. Opens itself once for a
 * brand-new user (no transactions yet) as soon as that is actually known — `isNew`
 * flips from unknown to true/false only after the first load finishes. */
function ProtectCollapse({ go, isNew }) {
  const [open, setOpen] = useState(false);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (isNew && !autoOpened.current) { autoOpened.current = true; setOpen(true); }
  }, [isNew]);
  return (
    <div className="card protect-card">
      <button className="protect-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="card-title" style={{ margin: 0, flex: 1 }}>
          <h3><span className="ico">🛡️</span> How every payment is protected</h3>
        </span>
        <span className="chev">{open ? '▲ Hide' : '▼ Show how'}</span>
      </button>
      {open && (
        <>
          <ProtectionStrip />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn ghost sm" onClick={() => go('transactions')}>See it on your payments</button>
          </div>
        </>
      )}
    </div>
  );
}

function BankCard({ acct, loading, label = 'Checking' }) {
  const avail = acct ? acct.balance - acct.heldAmount : 0;
  const heldPct = acct?.balance ? Math.min((acct.heldAmount / acct.balance) * 100, 100) : 0;
  return (
    <div className="u-card3d">
      <div className="u-cc">
        <div className="u-cc-top"><span className="u-cc-brand">🛡️ SentinelPay</span><span className="u-cc-type">{label}</span></div>
        <div className="u-cc-chip" aria-hidden="true" />
        <div className="u-cc-label">Available to spend</div>
        <div className="u-cc-bal">{loading ? '…' : money(avail)}</div>
        <div className="u-cc-foot">
          <span className="mono" title={acct?.accountNumber}>{acct?.accountNumber ? `•••• ${acct.accountNumber.slice(-4)}` : '—'}</span>
          <span>Balance {loading ? '…' : money(acct?.balance)}</span>
        </div>
        {acct?.heldAmount > 0 && (
          <div className="u-cc-hold" title={`${money(acct.heldAmount)} held while payments are being checked`}>
            <span><i style={{ width: `${heldPct}%` }} /></span>{money(acct.heldAmount)} on hold
          </div>
        )}
      </div>
    </div>
  );
}

function OverviewTab({ user, checking, savings, txns, beneficiaries, notifs, loading, go, onReview, onOpen, onPay }) {
  const unread = notifs.filter((n) => !n.read).length;
  const needs = txns.filter((t) => t.status === 'CHALLENGED');
  const blocked = txns.filter((t) => t.status === 'BLOCKED');
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const thisMonth = txns.filter((t) => new Date(t.createdAt) >= monthStart);
  const sent = thisMonth.filter((t) => isOut(t) && t.status === 'COMPLETED').reduce((a, t) => a + Number(t.amount || 0), 0);
  const received = thisMonth.filter((t) => !isOut(t) && t.status === 'COMPLETED').reduce((a, t) => a + Number(t.amount || 0), 0);
  const stopped = thisMonth.filter((t) => t.status === 'BLOCKED').reduce((a, t) => a + Number(t.amount || 0), 0);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const recentPayees = [...beneficiaries].sort((a, b) => {
    const last = (p) => Math.max(0, ...txns.filter((t) => String(t.beneficiaryId) === String(p._id)).map((t) => +new Date(t.createdAt)));
    return last(b) - last(a);
  }).slice(0, 6);
  const NOTE_ICO = { FRAUD_ALERT: '🚨', WARNING: '⚠️', SUCCESS: '✅', INFO: 'ℹ️' };

  return (
    <>
      <section className="u-top">
        <BankCard acct={checking} loading={loading} />
        <div className="u-welcome">
          <div className="u-hello">{greet}, <b>{user.fullName || user.email.split('@')[0]}</b> 👋</div>
          <div className="u-date">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <div className="u-quick">
            <button onClick={() => go('transfer')} className="u-qa send"><span>💸</span>Send money</button>
            <button onClick={() => go('beneficiaries')} className="u-qa payees"><span>👥</span>Payees<em>{beneficiaries.length}</em></button>
            <button onClick={() => go('transactions')} className="u-qa activity"><span>🧾</span>Activity<em>{txns.length}</em></button>
            <button onClick={() => go('notifications')} className="u-qa alerts"><span>🔔</span>Alerts{unread > 0 && <em className="hot">{unread}</em>}</button>
          </div>
          <div className="u-month">
            <div className="u-month-h">This month</div>
            <div className="u-month-row">
              <div><span>Sent</span><b>{money(sent)}</b></div>
              <div><span>Received</span><b className="in">{money(received)}</b></div>
              <div><span>Stopped by security</span><b className={stopped ? 'bad' : ''}>{money(stopped)}</b></div>
            </div>
          </div>
          {savings && <div className="u-savings">🏦 Savings <b>{money(savings.balance)}</b> <span className="mono">•••• {savings.accountNumber?.slice(-4)}</span></div>}
        </div>
      </section>

      {needs.length > 0 && (
        <section className="u-needs">
          <div className="u-needs-h">
            <span className="u-needs-ico">⚠️</span>
            <div><b>{needs.length === 1 ? '1 payment needs your answer' : `${needs.length} payments need your answer`}</b><span>They are on hold. The money stays in your account until you confirm or report each one.</span></div>
          </div>
          <div className="u-needs-list">
            {needs.map((t) => (
              <div key={t._id} className="u-needs-item">
                <Avatar name={txName(t, beneficiaries)} size={32} />
                <div><b>{money(t.amount)} to {txName(t, beneficiaries)}</b><span>{t.country} · risk {t.fraudProbability != null ? `${Math.round(t.fraudProbability * 100)}%` : '—'} · {timeAgo(t.createdAt)}</span></div>
                <button className="btn sm success" onClick={() => onReview(t)}>Review</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {beneficiaries.length > 0 && (
        <section className="u-pay-strip">
          <span className="u-pay-strip-l">Quick pay</span>
          <div className="u-pay-chips">
            {recentPayees.map((b) => (
              <button key={b._id} className="u-pay-chip" onClick={() => onPay(b.accountNumber)} title={`Pay ${b.nickname} · ${b.accountNumber}`}>
                <Avatar name={b.nickname} size={40} /><span>{b.nickname}</span>
              </button>
            ))}
            <button className="u-pay-chip add" onClick={() => go('beneficiaries')} title="Add a payee"><span className="u-av add">＋</span><span>Add</span></button>
          </div>
        </section>
      )}

      <ProtectCollapse go={go} isNew={!loading && txns.length === 0} />

      <div className="grid sidebar">
        <div>
          <div className="card">
            <div className="card-title"><h3><span className="ico">📊</span> Your money over time</h3></div>
            {txns.length === 0
              ? <Empty icon="📊" title="Nothing to chart yet" text="Once you make your first transfer or payment, your daily money in and out will appear here." />
              : <MoneyChart txns={txns} />}
            {txns.length >= 200 && <div className="card-hint">Based on your latest 200 transactions.</div>}
          </div>

          <div className="card">
            <div className="card-title">
              <h3><span className="ico">🧾</span> Recent activity</h3>
              <button className="btn ghost sm" onClick={() => go('transactions')}>View all</button>
            </div>
            {loading ? <p className="faint">Loading…</p>
              : txns.length === 0
                ? <Empty icon="🧾" title="No transactions yet" text="You have no transactions yet. Start your first payment to see your activity here." />
                : <div className="u-acts">{txns.slice(0, 6).map((t) => <ActivityRow key={t._id} t={t} bens={beneficiaries} onClick={() => onOpen(t)} />)}</div>}
            {blocked.length > 0 && <div className="card-hint">🚨 {blocked.length} payment{blocked.length > 1 ? 's were' : ' was'} stopped by the fraud check — open one to see why.</div>}
          </div>
        </div>

        <div>
          <div className="card">
            <div className="card-title"><h3><span className="ico">🔔</span> Latest alerts</h3>{unread > 0 && <span className="u-unread">{unread} new</span>}</div>
            {notifs.length === 0
              ? <Empty icon="🔔" title="All quiet" text="Account alerts will appear here." />
              : (
                <div className="u-notes">
                  {notifs.slice(0, 5).map((n) => (
                    <div key={n._id} className={`u-note ${n.type} ${n.read ? '' : 'unread'}`}>
                      <span className="u-note-ico">{NOTE_ICO[n.type] || 'ℹ️'}</span>
                      <div><b>{n.title}</b>{n.body && <span>{n.body}</span>}<em>{timeAgo(n.createdAt)}</em></div>
                    </div>
                  ))}
                </div>
              )}
            {notifs.length > 0 && <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => go('notifications')}>Open all alerts</button>}
          </div>

          <div className="card">
            <div className="card-title"><h3><span className="ico">🍩</span> Where your money went</h3></div>
            <WhereMoneyWent txns={txns} beneficiaries={beneficiaries} />
            <div className="card-hint">Completed payments only, grouped by payee or merchant. Home country for security checks: <b>{user.homeCountry || 'US'}</b>.</div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------- transfer ---------- */

const COUNTRIES = [['US', 'United States'], ['GB', 'United Kingdom'], ['DE', 'Germany'], ['FR', 'France'], ['NG', 'Nigeria'], ['IN', 'India'], ['BR', 'Brazil'], ['CA', 'Canada']];
const QUICK_AMOUNTS = [25, 50, 100, 250, 500];

function TransferTab({ data, user, flashMsg, reload, onDecide, payTo, go }) {
  const [form, setForm] = useState({ toAccount: payTo || '', amount: '', merchant: '', country: user?.homeCountry || 'US' });
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [signals, setSignals] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const checking = data.accounts.find((a) => a.type === 'CHECKING');
  const avail = checking ? checking.balance - checking.heldAmount : null;
  const payee = data.beneficiaries.find((b) => b.accountNumber === form.toAccount);
  const amount = Number(form.amount || 0);
  const home = user?.homeCountry || 'US';
  const tooMuch = avail != null && amount > avail;
  const paidBefore = payee && data.txns.some((t) => String(t.beneficiaryId) === String(payee._id) && t.status === 'COMPLETED');

  // live preview of the signals the fraud engine will be given (debounced)
  useEffect(() => {
    if (!form.toAccount && !form.amount) { setSignals(null); return undefined; }
    const q = new URLSearchParams({ toAccount: form.toAccount, amount: form.amount || '0', country: form.country });
    const id = setTimeout(() => { api(`/transfer/signals?${q}`).then(setSignals).catch(() => setSignals(null)); }, 300);
    return () => clearTimeout(id);
  }, [form.toAccount, form.amount, form.country, last]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.toAccount || !amount) return;
    setBusy(true);
    try {
      const res = await api('/transfer', { method: 'POST', body: { ...form, amount } });
      setLast({ ...res, decisionSource: res.source, country: form.country, createdAt: res.createdAt || new Date().toISOString() });
      if (res.status === 'CHALLENGED') {
        flashMsg('warn', 'This payment looked unusual, so it is on hold. Confirm or report it in "What happened to your payment".');
      } else if (res.status === 'BLOCKED') {
        flashMsg('fraud', 'This transaction was blocked because suspicious activity was detected.', 10000);
      } else if (res.status === 'COMPLETED') {
        flashMsg('ok', `Payment sent — ${money(res.amount || amount)} · ${res.txId}.`);
      } else {
        flashMsg('info', `Payment ${res.txId} is ${res.status}.`);
      }
      setForm((f) => ({ ...f, amount: '', merchant: '' }));
      await reload();
    } catch (err) {
      flashMsg('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  // the stored record keeps the panel current after the payment is answered or settled elsewhere
  const live = last && data.txns.find((t) => t.txId === last.txId);
  const shown = live ? { ...last, ...live } : last;

  return (
    <div className="grid sidebar">
      <div className="card u-send">
        <div className="page-head" style={{ marginBottom: 16 }}>
          <h2>Send money</h2>
          <div className="sub">Pick who, how much and where. Every payment is scored in real time by our fraud engine before any money moves.</div>
        </div>
        <form onSubmit={submit}>
          <div className="u-stepl"><span>1</span>Who are you paying?</div>
          {data.beneficiaries.length === 0
            ? <div className="u-nopayee">You have no saved payees yet. <button type="button" className="btn sm" onClick={() => go('beneficiaries')}>Add a payee</button></div>
            : (
              <div className="u-payees" role="radiogroup" aria-label="Payee">
                {data.beneficiaries.map((b) => (
                  <button type="button" role="radio" aria-checked={form.toAccount === b.accountNumber} key={b._id}
                    className={`u-payee ${form.toAccount === b.accountNumber ? 'on' : ''}`} onClick={() => setForm((f) => ({ ...f, toAccount: b.accountNumber }))}>
                    <Avatar name={b.nickname} size={36} />
                    <span><b>{b.nickname}</b><em>{b.bankName || 'Bank'} · •••• {b.accountNumber.slice(-4)}</em></span>
                    <i className="u-payee-tick">✓</i>
                  </button>
                ))}
                <button type="button" className="u-payee add" onClick={() => go('beneficiaries')}><span className="u-av add">＋</span><span><b>New payee</b><em>Save someone first</em></span></button>
              </div>
            )}
          <div className="hint" style={{ marginTop: 6 }}>Payments to unknown accounts are scored as higher risk.</div>

          <div className="u-stepl"><span>2</span>How much?</div>
          <div className={`u-amount ${tooMuch ? 'bad' : ''}`}>
            <span>$</span>
            <input required type="number" min="0.01" step="0.01" placeholder="0.00" value={form.amount} onChange={set('amount')} aria-label="Amount in USD" />
            <em>USD</em>
          </div>
          <div className="u-chips">
            {QUICK_AMOUNTS.map((v) => <button type="button" key={v} className={amount === v ? 'on' : ''} onClick={() => setForm((f) => ({ ...f, amount: String(v) }))}>${v}</button>)}
          </div>
          <div className={`hint ${tooMuch ? 'u-bad' : ''}`}>{avail == null ? '' : tooMuch ? `That is more than your available balance (${money(avail)}).` : `Available: ${money(avail)}`}</div>

          <div className="u-stepl"><span>3</span>Where and what for?</div>
          <div className="form-row">
            <div className="field">
              <label>Country</label>
              <select value={form.country} onChange={set('country')}>
                {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{c} · {n}{c === home ? ' (home)' : ''}</option>)}
              </select>
              {form.country !== home && <div className="hint">Counts as a foreign payment in the fraud check (home: {home}).</div>}
            </div>
            <div className="field">
              <label>Reference (optional)</label>
              <input placeholder="e.g. Electric bill" value={form.merchant} onChange={set('merchant')} />
            </div>
          </div>

          <div className={`u-summary ${form.toAccount && amount ? 'ready' : ''}`}>
            {form.toAccount && amount ? (
              <>
                <Avatar name={payee?.nickname || form.toAccount} size={40} />
                <div className="u-summary-t">
                  <span>You are sending</span>
                  <b>{money(amount)} to {payee?.nickname || form.toAccount}</b>
                  <em>{payee?.bankName ? `${payee.bankName} · ` : ''}{form.toAccount} · {form.country}{form.merchant ? ` · “${form.merchant}”` : ''}{paidBefore ? ' · paid before' : ' · first payment to this payee'}</em>
                </div>
              </>
            ) : <span className="faint">Choose a payee and an amount to see a summary here.</span>}
            <button className="btn" type="submit" disabled={busy || !form.toAccount || !amount}>{busy ? 'Checking…' : 'Send payment →'}</button>
          </div>
        </form>
        <div className="sig-card">
          <div className="sig-title">🔎 What the fraud check will see</div>
          {signals
            ? <SignalPreview s={signals} />
            : <p className="faint" style={{ fontSize: 13, margin: 0 }}>Pick a payee and type an amount — the signals our fraud engine will measure appear here as you type.</p>}
          <div className="card-hint">Computed by the server exactly as for the real payment. The risk score itself is only calculated when you send.</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title"><h3><span className="ico">🔍</span> What happened to your payment</h3></div>
        {!last
          ? (
            <>
              <PipelineArt className="side-art" />
              <p style={{ color: 'var(--text-dim)', fontSize: 13.5 }}>After you press <b>Send payment</b>, every step your payment goes through shows up here: the risk signals we measured, the fraud-engine score, the decision and where the data goes next.</p>
            </>
          )
          : <PaymentJourney tx={shown} onDecide={onDecide} />}
      </div>
    </div>
  );
}

/* ---------- transactions ---------- */

const TX_FILTERS = [['all', 'All'], ['COMPLETED', 'Completed'], ['CHALLENGED', 'Needs you'], ['BLOCKED', 'Blocked']];

function TxnTab({ txns, beneficiaries, loading, onDecide, focus }) {
  const [open, setOpen] = useState(focus);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (focus && !loading) setTimeout(() => document.getElementById(`tx-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }, [focus, loading]);
  const [filter, setFilter] = useState('all');
  if (loading) return <div className="card"><p style={{ color: 'var(--text-dim)' }}>Loading…</p></div>;
  const needle = q.trim().toLowerCase();
  const shown = txns.filter((t) => (filter === 'all' || t.status === filter)
    && (!needle || [txName(t, beneficiaries), t.merchant, t.txId, t.country].some((v) => (v || '').toLowerCase().includes(needle))));
  const pick = (id) => {
    setOpen(id);
    setFilter((f) => (f === 'all' || txns.find((t) => t._id === id)?.status === f ? f : 'all'));
    setTimeout(() => document.getElementById(`tx-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };
  const sum = (arr) => arr.reduce((a, t) => a + Number(t.amount || 0), 0);
  const done = txns.filter((t) => t.status === 'COMPLETED' && isOut(t));
  const needs = txns.filter((t) => t.status === 'CHALLENGED');
  const blocked = txns.filter((t) => t.status === 'BLOCKED');
  const scored = txns.filter((t) => t.fraudProbability != null);
  const avgRisk = scored.length ? scored.reduce((a, t) => a + t.fraudProbability, 0) / scored.length : null;
  // group the visible payments by day
  const groups = [];
  for (const t of shown) {
    const k = dayKey(t.createdAt);
    if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, label: dayLabel(t.createdAt), items: [] });
    groups[groups.length - 1].items.push(t);
  }

  return (
    <>
      <div className="u-sumstrip">
        <div className="ok"><span>✅</span><b>{money(sum(done))}</b><em>sent · {done.length} payment{done.length === 1 ? '' : 's'}</em></div>
        <button className="warn" onClick={() => setFilter('CHALLENGED')}><span>⏳</span><b>{needs.length}</b><em>need your answer</em></button>
        <button className="bad" onClick={() => setFilter('BLOCKED')}><span>🚨</span><b>{blocked.length}</b><em>blocked · {money(sum(blocked))} kept safe</em></button>
        <div className="info"><span>🎯</span><b>{avgRisk == null ? '—' : `${Math.round(avgRisk * 100)}%`}</b><em>average risk score</em></div>
      </div>

      {txns.some((t) => t.fraudProbability != null) && (
        <div className="card">
          <div className="card-title">
            <h3><span className="ico">🎯</span> Risk map</h3>
            <span className="rmap-legend"><i style={{ background: 'var(--success)' }} />completed <i style={{ background: 'var(--warn)' }} />needs you <i style={{ background: 'var(--danger)' }} />blocked</span>
          </div>
          <RiskMap txns={shown} selected={open} onPick={pick} />
        </div>
      )}
      <div className="card">
        <div className="page-head row between" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2>Transactions</h2>
            <div className="sub">Click a payment to see every step it went through — risk signals, score, decision and where the data went.</div>
          </div>
        </div>
        <div className="u-txtools">
          <div className="seg">
            {TX_FILTERS.map(([id, label]) => (
              <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
                {label} <span className="seg-count">{id === 'all' ? txns.length : txns.filter((t) => t.status === id).length}</span>
              </button>
            ))}
          </div>
          <label className="u-search"><span>🔍</span><input placeholder="Search payee, reference, TX id…" value={q} onChange={(e) => setQ(e.target.value)} />{q && <button onClick={() => setQ('')} aria-label="Clear search">✕</button>}</label>
        </div>
        {shown.length === 0 && <Empty icon="🧾" title="Nothing here yet" text={txns.length ? 'No payments match this filter or search.' : 'You have no transactions yet. Start your first payment to see your activity here.'} />}
        {groups.map((g) => (
          <div key={g.k} className="u-day">
            <div className="u-day-h"><span>{g.label}</span><em>{g.items.length} payment{g.items.length === 1 ? '' : 's'}</em></div>
            {g.items.map((t) => (
              <div key={t._id} id={`tx-${t._id}`} className={`u-tx ${open === t._id ? 'open' : ''}`}>
                <div className="u-tx-row" role="button" tabIndex={0}
                  onClick={() => { if (open !== t._id) track('ui.payment_details', 'transactions', { status: t.status }, t.txId); setOpen(open === t._id ? null : t._id); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') setOpen(open === t._id ? null : t._id); }}>
                  <Avatar name={txName(t, beneficiaries)} size={38} />
                  <span className="u-act-main">
                    <b>{txName(t, beneficiaries)}{t.merchant && payeeOf(t, beneficiaries) ? <em> · {t.merchant}</em> : null}</b>
                    <span>{clock(t.createdAt)} · {t.country || "—"}<span className="u-txid"> · <span className="mono">{t.txId}</span></span></span>
                  </span>
                  <span className="u-tx-risk"><RiskBadge level={t.riskLevel} prob={t.fraudProbability} /></span>
                  <span className="u-act-right">
                    <b className={`amount ${isOut(t) ? '' : 'in'} ${t.status === 'BLOCKED' ? 'struck' : ''}`}>{isOut(t) ? '−' : '+'}{money(t.amount)}</b>
                    <Tag status={t.status} />
                  </span>
                  <span className="u-tx-chev">
                    {t.status === 'CHALLENGED' && open !== t._id
                      ? <><button className="btn sm success u-cor" onClick={(e) => { e.stopPropagation(); setOpen(t._id); }}>Confirm or report</button><span className="u-chev-sm">▼</span></>
                      : open === t._id ? '▲' : '▼'}
                  </span>
                </div>
                {open === t._id && <div className="u-tx-journey"><PaymentJourney tx={t} onDecide={onDecide} /></div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------- payees ---------- */

function BeneficiaryTab({ data, flashMsg, reload, onPay }) {
  const [form, setForm] = useState({ nickname: '', accountNumber: '', bankName: '' });
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/beneficiaries', { method: 'POST', body: form });
      flashMsg('ok', `Payee "${form.nickname}" added.`);
      setForm({ nickname: '', accountNumber: '', bankName: '' });
      await reload();
    } catch (err) {
      flashMsg('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const stats = (b) => {
    const mine = data.txns.filter((t) => String(t.beneficiaryId) === String(b._id));
    const ok = mine.filter((t) => t.status === 'COMPLETED');
    return { n: mine.length, total: ok.reduce((a, t) => a + Number(t.amount || 0), 0), last: mine[0]?.createdAt, held: mine.filter((t) => t.status === 'CHALLENGED').length, blocked: mine.filter((t) => t.status === 'BLOCKED').length };
  };
  const needle = q.trim().toLowerCase();
  const list = data.beneficiaries.filter((b) => !needle || [b.nickname, b.bankName, b.accountNumber].some((v) => (v || '').toLowerCase().includes(needle)));
  const maxTotal = Math.max(...data.beneficiaries.map((b) => stats(b).total), 1);

  return (
    <div className="grid sidebar">
      <div className="card">
        <div className="card-title">
          <h3><span className="ico">👥</span> Saved payees <span className="u-count">{data.beneficiaries.length}</span></h3>
          {data.beneficiaries.length > 3 && <label className="u-search sm"><span>🔍</span><input placeholder="Search payees" value={q} onChange={(e) => setQ(e.target.value)} /></label>}
        </div>
        {data.beneficiaries.length === 0
          ? <Empty icon="👥" title="No payees yet" text="Add someone on the right to make repeat transfers faster and lower-risk." />
          : (
            <div className="u-pgrid">
              {list.map((b) => {
                const s = stats(b);
                return (
                  <div key={b._id} className="u-pcard" style={{ '--h': hueOf(b.nickname) }}>
                    <div className="u-pcard-top">
                      <Avatar name={b.nickname} size={46} />
                      <div><b>{b.nickname}</b><span>{b.bankName || 'Bank not given'}</span></div>
                    </div>
                    <div className="u-pcard-acct mono">{b.accountNumber}</div>
                    <div className="u-pcard-stats">
                      <div><b>{s.n}</b><span>payment{s.n === 1 ? '' : 's'}</span></div>
                      <div><b>{money(s.total)}</b><span>sent</span></div>
                      <div><b>{s.last ? timeAgo(s.last) : '—'}</b><span>last paid</span></div>
                    </div>
                    <div className="u-pcard-bar" title="Share of all money you sent to payees"><i style={{ width: `${(s.total / maxTotal) * 100}%` }} /></div>
                    {(s.held > 0 || s.blocked > 0) && <div className="u-pcard-flags">{s.held > 0 && <span className="badge CHALLENGED">{s.held} need you</span>}{s.blocked > 0 && <span className="badge BLOCKED">{s.blocked} blocked</span>}</div>}
                    <div className="u-pcard-foot"><span className="faint">added {timeAgo(b.createdAt)}</span><button className="btn sm" onClick={() => onPay(b.accountNumber)}>💸 Pay</button></div>
                  </div>
                );
              })}
              {list.length === 0 && <p className="faint">No payee matches “{q}”.</p>}
            </div>
          )}
      </div>
      <div className="card u-addpayee">
        <div className="card-title"><h3><span className="ico">➕</span> Add a payee</h3></div>
        <div className="u-preview">
          <Avatar name={form.nickname || '?'} size={54} />
          <div><b>{form.nickname || 'New payee'}</b><span>{form.bankName || 'Bank'} · <span className="mono">{form.accountNumber || 'SPY-XXXXXX-1234'}</span></span></div>
        </div>
        <form onSubmit={add}>
          <div className="field">
            <label>Nickname</label>
            <input required placeholder="Mom" value={form.nickname} onChange={set('nickname')} />
          </div>
          <div className="field">
            <label>Account number</label>
            <input required placeholder="SPY-XXXXXX-1234" value={form.accountNumber} onChange={set('accountNumber')} />
          </div>
          <div className="field">
            <label>Bank (optional)</label>
            <input placeholder="Chase" value={form.bankName} onChange={set('bankName')} />
          </div>
          <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Saving…' : 'Add payee'}</button>
        </form>
        <div className="card-hint">Saved payees make repeat transfers faster. Payments to unknown accounts are scored as higher risk.</div>
      </div>
    </div>
  );
}

/* ---------- notifications ---------- */

const NOTE_KIND = {
  WARNING: { ico: '⏳', label: 'Needs action' },
  FRAUD_ALERT: { ico: '🚨', label: 'Security' },
  SUCCESS: { ico: '✅', label: 'Payments' },
  INFO: { ico: 'ℹ️', label: 'Account' }
};

function NotifTab({ notifs, txns, reload, onReview }) {
  const [kind, setKind] = useState('all');
  const markRead = async (n) => {
    if (n.read) return;
    try { await api(`/notifications/${n._id}/read`, { method: 'POST' }); await reload(); }
    catch { /* stays unread; the next load shows the real state */ }
  };

  useEffect(() => {
    const unread = notifs.filter((n) => !n.read);
    if (unread.length === 0) return;
    let cancelled = false;
    Promise.allSettled(unread.map((n) => api(`/notifications/${n._id}/read`, { method: 'POST' }))).then(() => {
      if (!cancelled) reload();
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifs.length]);

  const shown = notifs.filter((n) => kind === 'all' || n.type === kind);
  const groups = [];
  for (const n of shown) {
    const k = dayKey(n.createdAt);
    if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, label: dayLabel(n.createdAt), items: [] });
    groups[groups.length - 1].items.push(n);
  }
  // a "confirm this transaction" alert links to the payment while it is still on hold
  const heldTx = (n) => { const id = (n.body || '').match(/\bTX[0-9A-F]{6,}\b/)?.[0]; return id && txns.find((t) => t.txId === id && t.status === 'CHALLENGED'); };

  return (
    <div className="card">
      <div className="card-title"><h3><span className="ico">🔔</span> Alerts & notifications</h3><span className="card-hint" style={{ marginTop: 0 }}>Opening this tab marks everything as read</span></div>
      <div className="u-kinds">
        <button className={kind === 'all' ? 'on' : ''} onClick={() => setKind('all')}>All <em>{notifs.length}</em></button>
        {Object.entries(NOTE_KIND).map(([k, m]) => {
          const n = notifs.filter((x) => x.type === k).length;
          return n ? <button key={k} className={`${kind === k ? 'on' : ''} ${k}`} onClick={() => setKind(k)}>{m.ico} {m.label} <em>{n}</em></button> : null;
        })}
      </div>
      {shown.length === 0
        ? <Empty icon="🔕" title="No notifications" text="Fraud alerts, payment confirmations and account updates will appear here." />
        : groups.map((g) => (
          <div key={g.k} className="u-day">
            <div className="u-day-h"><span>{g.label}</span><em>{g.items.length}</em></div>
            <div className="u-alerts">
              {g.items.map((n) => {
                const tx = n.type === 'WARNING' ? heldTx(n) : null;
                return (
                  <div key={n._id} className={`u-alert ${n.type} ${n.read ? '' : 'unread'}`} onClick={() => markRead(n)}>
                    <span className="u-alert-ico">{NOTE_KIND[n.type]?.ico || 'ℹ️'}</span>
                    <div className="u-alert-main">
                      <b>{n.title}{!n.read && <span className="u-new">NEW</span>}</b>
                      {n.body && <span>{n.body}</span>}
                      <em>{clock(n.createdAt)} · {timeAgo(n.createdAt)}</em>
                    </div>
                    {tx && <button className="btn sm success" onClick={(e) => { e.stopPropagation(); onReview(tx); }}>Review</button>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
    </div>
  );
}
