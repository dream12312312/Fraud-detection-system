import React, { useEffect, useState, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { api, saveSession, clearSession, verifySession, setAccessToken, setSessionExpiredHandler, useNow } from './lib.js';
import { PaymentJourney, ProtectionStrip } from './journey.jsx';
import { ShieldArt, PipelineArt } from './illustrations.jsx';
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
    { id: 'overview', ico: '🏠', label: 'Overview', hint: 'Balances and recent activity' },
    { id: 'transfer', ico: '💸', label: 'Send money', hint: 'Send money to a payee' },
    { id: 'beneficiaries', ico: '👥', label: 'Payees', hint: 'Saved payees for faster, lower-risk transfers' }
  ] },
  { group: 'Activity & security', items: [
    { id: 'transactions', ico: '🧾', label: 'Transactions', hint: 'History with how each payment was checked' },
    { id: 'notifications', ico: '🔔', label: 'Alerts', hint: 'Security and account notifications' }
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
              onClick={() => setTab(t.id)}
              title={t.hint}
              aria-label={`${t.label} — ${t.hint}`}
            >
              <span className="nav-ico">{t.ico}</span>{t.label}
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
  const [data, setData] = useState({ accounts: [], txns: [], notifs: [], beneficiaries: [] });
  const [loading, setLoading] = useState(true);
  const socketRef = useRef(null);
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

  // live updates over socket.io
  useEffect(() => {
    setSessionExpiredHandler(() => { clearSession(); onLogout(); });
    const socket = io('/', { withCredentials: true });
    socketRef.current = socket;
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

  const goTab = (t) => { setFocus(null); setTab(t); };
  const reviewing = data.txns.find((t) => t.status === 'CHALLENGED');
  // "Review" opens the payment itself in Transactions, where its verdict carries the answer buttons
  const openReview = (tx) => { const t = tx?.txId ? tx : reviewing; if (t) { setFocus(t._id); setTab('transactions'); } };

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
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand"><span className="logo">🛡️</span> SentinelPay</div>
        <div className="topbar-user">
          <ThemeToggle />
          <span className="status-dot ok" title="API connected" />
          <span>Signed in as <b>{user.fullName || user.email}</b></span>
          <button className="btn ghost sm" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <div className="layout">
        <SideNav user={user} tab={tab} setTab={goTab}unread={unread} challenged={Boolean(reviewing)} onLogout={onLogout} />
        <main className="main">
          <Flash flash={flash} onClose={clearFlash} />

          {tab === 'overview' && (
            <OverviewTab user={user} checking={checking} savings={savings} txns={data.txns} beneficiaries={data.beneficiaries} notifs={data.notifs} loading={loading} go={goTab} onReview={openReview} />
          )}
          {tab === 'transfer' && <TransferTab data={data} flashMsg={flashMsg} reload={load} onDecide={decide} />}
          {tab === 'transactions' && <TxnTab txns={data.txns} loading={loading} onDecide={decide} focus={focus} />}
          {tab === 'beneficiaries' && <BeneficiaryTab data={data} flashMsg={flashMsg} reload={load} />}
          {tab === 'notifications' && <NotifTab notifs={data.notifs} reload={load} now={now} />}
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

/* ---------- overview ---------- */

/** Compact, clickable stat pills — replaces five separate KPI cards with one row. */
function StatStrip({ loading, balance, n, blocked, unread, go }) {
  return (
    <div className="stat-strip">
      <div className="stat" title="Money in your checking account, including funds on hold">
        <span className="stat-ico">💼</span><span className="stat-v">{loading ? '…' : money(balance)}</span><span className="stat-l">Checking balance</span>
      </div>
      <button className="stat as-btn" onClick={() => go('transactions')} title="Every transaction you have made">
        <span className="stat-ico">🧾</span><span className="stat-v">{n}</span><span className="stat-l">Transactions</span>
      </button>
      <button className="stat as-btn" onClick={() => go('transactions')} title="Transactions our fraud engine stopped">
        <span className="stat-ico">🚨</span><span className="stat-v" style={{ color: blocked ? 'var(--danger)' : undefined }}>{blocked}</span><span className="stat-l">Blocked by fraud AI</span>
      </button>
      <button className="stat as-btn" onClick={() => go('notifications')} title="Unread security and account notifications">
        <span className="stat-ico">🔔</span><span className="stat-v" style={{ color: unread ? 'var(--warn)' : undefined }}>{unread}</span><span className="stat-l">Unread alerts</span>
      </button>
    </div>
  );
}

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

function OverviewTab({ user, checking, savings, txns, beneficiaries, notifs, loading, go, onReview }) {
  const unread = notifs.filter((n) => !n.read).length;
  const challenged = txns.find((t) => t.status === 'CHALLENGED');
  const nChallenged = txns.filter((t) => t.status === 'CHALLENGED').length;
  const blocked = txns.filter((t) => t.status === 'BLOCKED').length;
  const avail = checking ? checking.balance - checking.heldAmount : 0;
  const heldPct = checking?.balance ? Math.min((checking.heldAmount / checking.balance) * 100, 100) : 0;

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <div className="hero">
        <div className="greet">{greet}, {user.fullName || user.email.split('@')[0]} 👋</div>
        <div className="hero-row">
          <div>
            <div className="big-balance">{loading ? '…' : money(avail)}</div>
            <div className="hero-meta">
              Available to spend · {checking?.accountNumber || '—'}
              {checking?.heldAmount > 0 && (
                <span className="hold-pill" title={`${money(checking.heldAmount)} held while payments are being checked`}>
                  <span className="hold-bar"><span style={{ width: `${heldPct}%` }} /></span>
                  {money(checking.heldAmount)} on hold
                </span>
              )}
            </div>
          </div>
          <div className="quick-actions">
            <button className="btn" onClick={() => go('transfer')} title="Send money to a payee or merchant">💸 Send money</button>
            <button className="btn ghost" onClick={() => go('transactions')} title="See all transactions and their fraud decisions">🧾 Activity</button>
          </div>
        </div>
        <ShieldArt className="hero-art" />
      </div>

      <StatStrip loading={loading} balance={checking?.balance} n={txns.length} blocked={blocked} unread={unread} go={go} />

      <ProtectCollapse go={go} isNew={!loading && txns.length === 0} />

      <div className="grid sidebar">
        <div>
          {challenged && (
            <div className="flash warn" style={{ marginTop: 0 }}>
              <span>⚠️</span>
              <div style={{ flex: 1 }}>
                <b>Action needed</b>
                {nChallenged > 1
                  ? `${nChallenged} payments are on hold until you confirm or report them.`
                  : `Payment ${challenged.txId} (${money(challenged.amount)}) is on hold until you confirm or report it.`}
              </div>
              <button className="btn sm success" onClick={() => onReview(challenged)}>Review</button>
            </div>
          )}

          <div className="card" style={{ marginTop: challenged ? 18 : 0 }}>
            <div className="card-title">
              <h3><span className="ico">📊</span> Your money over time</h3>
            </div>
            {txns.length === 0
              ? <Empty icon="📊" title="Nothing to chart yet" text="Once you make your first transfer or payment, your daily money in and out will appear here." />
              : <MoneyChart txns={txns} />}
            {txns.length >= 200 && <div className="card-hint">Based on your latest 200 transactions.</div>}
          </div>

          <div className="card">
            <div className="card-title">
              <h3><span className="ico">🧾</span> Recent transactions</h3>
              <button className="btn ghost sm" onClick={() => go('transactions')}>View all</button>
            </div>
            {loading ? <p style={{ color: 'var(--text-dim)' }}>Loading…</p>
              : txns.length === 0
                ? <Empty icon="🧾" title="No transactions yet" text="You have no transactions yet. Start your first payment to see your activity here." />
                : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
                      <tbody>
                        {txns.slice(0, 6).map((t) => (
                          <tr key={t._id}>
                            <td style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>{timeAgo(t.createdAt)}</td>
                            <td>{t.merchant || 'Transfer'} <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{t.txId}</span></td>
                            <td className={`amount ${t.type === 'DEPOSIT' ? 'in' : ''}`}>{t.type === 'DEPOSIT' ? '+' : '−'}{money(t.amount)}</td>
                            <td><span className={`badge ${t.status}`}>{t.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
          </div>
        </div>

        <div>
          <div className="card">
            <div className="card-title"><h3><span className="ico">🔔</span> Notifications</h3></div>
            {notifs.length === 0
              ? <Empty icon="🔔" title="All quiet" text="Account alerts will appear here." />
              : notifs.slice(0, 5).map((n) => (
                <div key={n._id} className={`notif ${n.read ? '' : 'unread'}`}>
                  <div className="title">{n.title}</div>
                  {n.body && <div className="body">{n.body}</div>}
                  <div className="time">{timeAgo(n.createdAt)}</div>
                </div>
              ))}
            {notifs.length > 0 && (
              <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => go('notifications')}>
                {unread > 0 ? `${unread} unread — open Alerts` : 'Open Alerts'}
              </button>
            )}
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

const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'NG', 'IN', 'BR', 'CA'];

function TransferTab({ data, flashMsg, reload, onDecide }) {
  const [form, setForm] = useState({ toAccount: '', amount: '', merchant: '', country: 'US' });
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [signals, setSignals] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // live preview of the signals the fraud engine will be given (debounced)
  useEffect(() => {
    if (!form.toAccount && !form.amount) { setSignals(null); return undefined; }
    const q = new URLSearchParams({ toAccount: form.toAccount, amount: form.amount || '0', country: form.country });
    const id = setTimeout(() => { api(`/transfer/signals?${q}`).then(setSignals).catch(() => setSignals(null)); }, 300);
    return () => clearTimeout(id);
  }, [form.toAccount, form.amount, form.country, last]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api('/transfer', { method: 'POST', body: { ...form, amount: Number(form.amount) } });
      setLast({ ...res, decisionSource: res.source, country: form.country, createdAt: res.createdAt || new Date().toISOString() });
      if (res.status === 'CHALLENGED') {
        flashMsg('warn', 'This payment looked unusual, so it is on hold. Confirm or report it in "What happened to your payment".');
      } else if (res.status === 'BLOCKED') {
        flashMsg('fraud', 'This transaction was blocked because suspicious activity was detected.', 10000);
      } else if (res.status === 'COMPLETED') {
        flashMsg('ok', `Payment sent — ${money(res.amount || Number(form.amount))} · ${res.txId}.`);
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
      <div className="card">
        <div className="page-head" style={{ marginBottom: 14 }}>
          <h2>Send money</h2>
          <div className="sub">Please review your transaction details before confirming. Every payment is scored in real time by our fraud engine.</div>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label>To account</label>
            <select required value={form.toAccount} onChange={set('toAccount')}>
              <option value="" disabled>Select a beneficiary…</option>
              {data.beneficiaries.map((b) => (
                <option key={b._id} value={b.accountNumber}>{b.nickname} · {b.accountNumber}{b.bankName ? ` (${b.bankName})` : ''}</option>
              ))}
            </select>
            <div className="hint">Payments to unknown accounts are scored as higher risk.</div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Amount (USD)</label>
              <input required type="number" min="0.01" step="0.01" placeholder="250.00" value={form.amount} onChange={set('amount')} />
            </div>
            <div className="field">
              <label>Country</label>
              <select value={form.country} onChange={set('country')}>
                {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Merchant / reference (optional)</label>
            <input placeholder="e.g. Electric bill" value={form.merchant} onChange={set('merchant')} />
            <div className="hint">Leave empty for a plain account-to-account transfer.</div>
          </div>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Processing…' : 'Send payment'}</button>
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
          : (
            <>
              <div className="row between" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <span className="mono">{shown.txId}</span>
                <span className="row" style={{ gap: 6 }}><span className={`badge ${shown.status}`}>{shown.status}</span><RiskBadge level={shown.riskLevel} prob={shown.fraudProbability} /></span>
              </div>
              <PaymentJourney tx={shown} onDecide={onDecide} />
            </>
          )}
      </div>
    </div>
  );
}

/* ---------- transactions ---------- */

const TX_FILTERS = [['all', 'All'], ['COMPLETED', 'Completed'], ['CHALLENGED', 'Needs you'], ['BLOCKED', 'Blocked']];

function TxnTab({ txns, loading, onDecide, focus }) {
  const [open, setOpen] = useState(focus);
  useEffect(() => {
    if (focus && !loading) setTimeout(() => document.getElementById(`tx-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }, [focus, loading]);
  const [filter, setFilter] = useState('all');
  if (loading) return <div className="card"><p style={{ color: 'var(--text-dim)' }}>Loading…</p></div>;
  const shown = txns.filter((t) => filter === 'all' || t.status === filter);
  const pick = (id) => {
    setOpen(id);
    setFilter((f) => (f === 'all' || txns.find((t) => t._id === id)?.status === f ? f : 'all'));
    setTimeout(() => document.getElementById(`tx-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };
  return (
    <>
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
        <div className="seg">
          {TX_FILTERS.map(([id, label]) => (
            <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
              {label} <span className="seg-count">{id === 'all' ? txns.length : txns.filter((t) => t.status === id).length}</span>
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 && <Empty icon="🧾" title="Nothing here yet" text={txns.length ? 'No payments match this filter.' : 'You have no transactions yet. Start your first payment to see your activity here.'} />}
      {shown.length > 0 && (
        <div className="table-wrap">
          <table className="data clickable">
            <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Status</th><th>Risk</th><th /></tr></thead>
            <tbody>
              {shown.map((t) => (
                <React.Fragment key={t._id}>
                  <tr id={`tx-${t._id}`} onClick={() => setOpen(open === t._id ? null : t._id)} className={open === t._id ? 'sel' : ''}>
                    <td style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>{new Date(t.createdAt).toLocaleString()}</td>
                    <td>{t.merchant || 'Transfer'} <span className="mono" style={{ marginLeft: 6 }}>{t.txId}</span></td>
                    <td className={`amount ${t.type === 'DEPOSIT' ? 'in' : ''}`}>{t.type === 'DEPOSIT' ? '+' : '−'}{money(t.amount)}</td>
                    <td><span className={`badge ${t.status}`}>{t.status}</span></td>
                    <td><RiskBadge level={t.riskLevel} prob={t.fraudProbability} /></td>
                    <td className="faint" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {t.status === 'CHALLENGED' && open !== t._id && (
                        <button className="btn sm success" style={{ marginRight: 8 }} onClick={(e) => { e.stopPropagation(); setOpen(t._id); }}>Confirm or report</button>
                      )}
                      {open === t._id ? '▲' : '▼'}
                    </td>
                  </tr>
                  {open === t._id && (
                    <tr className="journey-row"><td colSpan={6}><PaymentJourney tx={t} onDecide={onDecide} /></td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </>
  );
}

function BeneficiaryTab({ data, flashMsg, reload }) {
  const [form, setForm] = useState({ nickname: '', accountNumber: '', bankName: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/beneficiaries', { method: 'POST', body: form });
      flashMsg('ok', `Beneficiary "${form.nickname}" added.`);
      setForm({ nickname: '', accountNumber: '', bankName: '' });
      await reload();
    } catch (err) {
      flashMsg('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid sidebar">
      <div className="card">
        <div className="card-title"><h3>Saved payees</h3></div>
        {data.beneficiaries.length === 0
          ? <Empty icon="👥" title="No beneficiaries" text="Add someone below to make repeat transfers faster and lower-risk." />
          : (
            <table className="data">
              <thead><tr><th>Nickname</th><th>Account</th><th>Bank</th><th>Added</th></tr></thead>
              <tbody>
                {data.beneficiaries.map((b) => (
                  <tr key={b._id}>
                    <td><b>{b.nickname}</b></td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12.5 }}>{b.accountNumber}</td>
                    <td>{b.bankName || '—'}</td>
                    <td style={{ color: 'var(--text-dim)' }}>{timeAgo(b.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      <div className="card">
        <div className="card-title"><h3>Add beneficiary</h3></div>
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
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add payee'}</button>
        </form>
      </div>
    </div>
  );
}

/* ---------- notifications ---------- */

function NotifTab({ notifs, reload, now }) {
  const [busyId, setBusyId] = useState(null);
  const markRead = async (n) => {
    if (n.read) return;
    setBusyId(n._id);
    try { await api(`/notifications/${n._id}/read`, { method: 'POST' }); await reload(); }
    finally { setBusyId(null); }
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

  return (
    <div className="card">
      <div className="card-title"><h3>Alerts & notifications</h3><span className="card-hint" style={{ marginTop: 0 }}>Opening this tab marks everything as read</span></div>
      {notifs.length === 0
        ? <Empty icon="🔕" title="No notifications" text="Fraud alerts, payment confirmations and account updates will appear here." />
        : notifs.map((n) => (
          <div key={n._id} className={`notif ${n.read ? '' : 'unread'}`} onClick={() => markRead(n)}>
            <div className="title">
              <span>{n.type === 'FRAUD_ALERT' ? '🚨' : n.type === 'WARNING' ? '⚠️' : n.type === 'SUCCESS' ? '✅' : 'ℹ️'}</span>
              {n.title}
              {!n.read && <span className="badge INFO">NEW</span>}
            </div>
            {n.body && <div className="body">{n.body}</div>}
            <div className="time">{timeAgo(n.createdAt)} · {new Date(n.createdAt).toLocaleString()}</div>
          </div>
        ))}
    </div>
  );
}
