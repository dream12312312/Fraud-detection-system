import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const API = '';
let socket = null;

function useAuth() {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('user') || 'null'));
  return { token, setToken, user, setUser };
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function Auth({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', fullName: '' });
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (mode === 'register') {
        await api('/auth/register', { method: 'POST', body: form });
      }
      const login = await api('/auth/login', { method: 'POST', body: { email: form.email, password: form.password } });
      localStorage.setItem('token', login.accessToken);
      localStorage.setItem('user', JSON.stringify(login.user));
      onAuth(login);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div style={{ maxWidth: 380, margin: '80px auto', background: '#1e293b', padding: 32, borderRadius: 12 }}>
      <h1 style={{ marginBottom: 8 }}>🛡️ SentinelPay</h1>
      <p style={{ color: '#94a3b8', marginBottom: 24 }}>Real-time fraud-protected banking</p>
      <form onSubmit={submit}>
        {mode === 'register' && (
          <input placeholder="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            style={inp} required />
        )}
        <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
          style={inp} required />
        <input placeholder="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
          style={inp} required minLength={8} />
        {error && <p style={{ color: '#f871', margin: '8px 0' }}>{error}</p>}
        <button style={btn} type="submit">{mode === 'login' ? 'Login' : 'Create account'}</button>
      </form>
      <button style={{ ...btn, background: 'transparent', border: '1px solid #334155', marginTop: 8 }}
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Need an account? Register' : 'Have an account? Login'}
      </button>
    </div>
  );
}

const inp = { width: '100%', padding: 10, margin: '6px 0', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#e2e8f0' };
const btn = { width: '100%', padding: 10, marginTop: 8, borderRadius: 8, border: 'none', background: '#2563eb', color: 'white', cursor: 'pointer', fontWeight: 600 };
const card = { background: '#1e293b', borderRadius: 12, padding: 20, marginBottom: 16 };
const row = { display: 'flex', gap: 16, flexWrap: 'wrap' };

function Dashboard({ token, user, onLogout }) {
  const [accounts, setAccounts] = useState([]);
  const [txns, setTxns] = useState([]);
  const [beneficiaries, setBeneficiaries] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [transfer, setTransfer] = useState({ toAccount: '', amount: '', merchant: '', country: 'US' });
  const [message, setMessage] = useState(null);

  const refresh = async () => {
    try {
      const [acc, tx, ben, notif] = await Promise.all([
        api('/accounts', { token }), api('/transactions', { token }),
        api('/beneficiaries', { token }), api('/notifications', { token })
      ]);
      setAccounts(acc); setTxns(tx); setBeneficiaries(ben); setNotifications(notif);
    } catch (err) { setMessage({ type: 'error', text: err.message }); }
  };

  useEffect(() => {
    refresh();
    socket = io('/', { withCredentials: true });
    socket.emit('join', { userId: user.id, role: user.role });
    socket.on('notification:new', (n) => {
      setNotifications((prev) => [n, ...prev]);
      setMessage({ type: n.type === 'FRAUD_ALERT' ? 'fraud' : 'info', text: `${n.title}: ${n.body}` });
      recordTransaction();
    });
    return () => socket.disconnect();
  }, []);

  const recordTransaction = () => { api('/transactions', { token }).then(setTxns).catch(() => {}); };

  const submitTransfer = async (e) => {
    e.preventDefault();
    setMessage(null);
    try {
      const res = await api('/transfer', { method: 'POST', token, body: { ...transfer, amount: Number(transfer.amount) } });
      if (res.status === 'BLOCKED') setMessage({ type: 'fraud', text: `Your transaction was blocked because unusual activity was detected. (${res.reasons?.join(', ')})` });
      else if (res.status === 'CHALLENGED') setMessage({ type: 'warn', text: 'Please confirm this transaction below.' });
      else setMessage({ type: 'ok', text: `Transfer completed (${res.txId})` });
      setTransfer({ toAccount: '', amount: '', merchant: '', country: 'US' });
      refresh();
    } catch (err) { setMessage({ type: 'error', text: err.message }); }
  };

  const confirmTx = async (txId) => { await api(`/transactions/${txId}/confirm`, { method: 'POST', token }); refresh(); };
  const reportTx = async (txId) => { await api(`/transactions/${txId}/report`, { method: 'POST', token }); refresh(); };
  const addBeneficiary = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/beneficiaries', { method: 'POST', token, body: Object.fromEntries(f) });
    refresh();
  };

  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const msgStyle = {
    error: '#f871', fraud: '#f871', warn: '#fbbf24', ok: '#4ade80', info: '#60a5fa'
  }[message?.type] || '#60a5fa';

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1>🛡️ SentinelPay</h1>
        <div>
          <span style={{ marginRight: 16, color: '#94a3b8' }}>{user.fullName} ({user.email})</span>
          <button style={{ ...btn, width: 'auto', padding: '8px 16px' }} onClick={() => { localStorage.clear(); onLogout(); }}>Logout</button>
        </div>
      </header>

      {message && <div style={{ background: '#1e293b', borderLeft: `4px solid ${msgStyle}`, padding: 14, borderRadius: 8, marginBottom: 16 }}>
        {message.text}
      </div>}

      <div style={row}>
        <div style={{ ...card, flex: 1 }}>
          <h3>Accounts</h3>
          {accounts.map((a) => (
            <p key={a._id} style={{ margin: '8px 0' }}>
              {a.accountNumber} · {a.type} — <b style={{ color: '#4ade80' }}>${a.balance.toFixed(2)}</b>
              {a.heldAmount > 0 && <span style={{ color: '#fbbf24' }}> (${a.heldAmount.toFixed(2)} on hold)</span>}
            </p>
          ))}
          <p style={{ marginTop: 12, color: '#94a3b8' }}>Total available: <b style={{ color: 'white' }}>${total.toFixed(2)}</b></p>
        </div>

        <div style={{ ...card, flex: 2 }}>
          <h3>New transfer / payment</h3>
          <form onSubmit={submitTransfer} style={row}>
            <input style={{ ...inp, flex: 1 }} placeholder="To account" required value={transfer.toAccount}
              onChange={(e) => setTransfer({ ...transfer, toAccount: e.target.value })} />
            <input style={{ ...inp, flex: 1 }} placeholder="Amount" type="number" step="0.01" min="0.01" required value={transfer.amount}
              onChange={(e) => setTransfer({ ...transfer, amount: e.target.value })} />
            <input style={{ ...inp, flex: 1 }} placeholder="Merchant (optional)" value={transfer.merchant}
              onChange={(e) => setTransfer({ ...transfer, merchant: e.target.value })} />
            <select style={inp} value={transfer.country} onChange={(e) => setTransfer({ ...transfer, country: e.target.value })}>
              {['US', 'CA', 'GB', 'FR', 'BR', 'NG', 'RU'].map((c) => <option key={c}>{c}</option>)}
            </select>
            <button style={btn} type="submit">Send</button>
          </form>

          <h3 style={{ marginTop: 20 }}>Add beneficiary</h3>
          <form onSubmit={addBeneficiary} style={row}>
            <input style={{ ...inp, flex: 1 }} name="nickname" placeholder="Nickname" required />
            <input style={{ ...inp, flex: 1 }} name="accountNumber" placeholder="Account number" required />
            <input style={{ ...inp, flex: 1 }} name="bankName" placeholder="Bank (optional)" />
            <button style={btn} type="submit">Add</button>
          </form>
          <div style={{ marginTop: 12 }}>
            {beneficiaries.map((b) => <span key={b._id} style={{ background: '#0f172a', borderRadius: 6, padding: '4px 10px', marginRight: 8, fontSize: 13 }}>{b.nickname} · {b.accountNumber}</span>)}
          </div>
        </div>
      </div>

      <div style={row}>
        <div style={{ ...card, flex: 2 }}>
          <h3>Transactions</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead><tr style={{ color: '#94a3b8', textAlign: 'left' }}>
              <th style={th}>ID</th><th style={th}>Type</th><th style={th}>Amount</th><th style={th}>Status</th><th style={th}>Risk</th><th style={th}>Actions</th>
            </tr></thead>
            <tbody>
              {txns.map((t) => (
                <tr key={t._id}>
                  <td style={td}>{t.txId}</td>
                  <td style={td}>{t.type}</td>
                  <td style={td}>${t.amount.toFixed(2)}</td>
                  <td style={td}><StatusBadge status={t.status} /></td>
                  <td style={td}>{t.fraudProbability != null ? `${Math.round(t.fraudProbability * 100)}%` : '—'}</td>
                  <td style={td}>
                    {t.status === 'CHALLENGED' && (<>
                      <button style={{ ...btn, width: 'auto', padding: '4px 10px', fontSize: 12, background: '#16a34a' }} onClick={() => confirmTx(t.txId)}>Confirm</button>
                      <button style={{ ...btn, width: 'auto', padding: '4px 10px', fontSize: 12, background: '#dc2626', marginLeft: 6 }} onClick={() => reportTx(t.txId)}>Report fraud</button>
                    </>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ ...card, flex: 1 }}>
          <h3>Security notifications</h3>
          {notifications.length === 0 && <p style={{ color: '#94a3b8' }}>No notifications yet.</p>}
          {notifications.map((n) => (
            <div key={n._id} style={{ padding: '10px 0', borderBottom: '1px solid #334155' }}>
              <b style={{ color: n.type === 'FRAUD_ALERT' ? '#f871' : n.type === 'WARNING' ? '#fbbf24' : '#4ade80' }}>{n.title}</b>
              <p style={{ fontSize: 13, color: '#cbd5e1' }}>{n.body}</p>
              <p style={{ fontSize: 11, color: '#64748b' }}>{new Date(n.createdAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const th = { padding: 8, borderBottom: '1px solid #334155' };
const td = { padding: 8, borderBottom: '1px solid #1e293b' };

function StatusBadge({ status }) {
  const colors = { COMPLETED: '#4ade80', BLOCKED: '#f871', CHALLENGED: '#fbbf24', PENDING_RISK_CHECK: '#60a5fa', FAILED: '#94a3b8' };
  return <span style={{ color: colors[status] || '#e2e8f0', fontWeight: 600, fontSize: 13 }}>{status}</span>;
}

export default function App() {
  const { token, user } = useAuth();
  const [auth, setAuth] = useState(Boolean(token && user));
  if (!auth) return <Auth onAuth={() => setAuth(true)} />;
  return <Dashboard token={token} user={user} onLogout={() => setAuth(false)} />;
}
