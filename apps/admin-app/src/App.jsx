import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

let socket = null;
const card = { background: '#111a2e', borderRadius: 12, padding: 20, marginBottom: 16 };
const inp = { width: '100%', padding: 10, margin: '6px 0', borderRadius: 8, border: '1px solid #334155', background: '#0a0f1e', color: '#e2e8f0' };
const btn = { padding: 8, borderRadius: 8, border: 'none', background: '#7c3aed', color: 'white', cursor: 'pointer', fontWeight: 600 };
const th = { padding: 8, borderBottom: '1px solid #334155', textAlign: 'left', color: '#94a3b8', fontSize: 13 };
const td = { padding: 8, borderBottom: '1px solid #1a2440', fontSize: 13 };

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

function Login({ onAuth }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      const login = await api('/auth/login', { method: 'POST', body: form });
      if (login.user.role !== 'admin') { setError('This console requires an admin account'); return; }
      localStorage.setItem('adminToken', login.accessToken);
      localStorage.setItem('adminUser', JSON.stringify(login.user));
      onAuth(login);
    } catch (err) { setError(err.message); }
  };
  return (
    <div style={{ maxWidth: 380, margin: '100px auto', background: '#111a2e', padding: 32, borderRadius: 12 }}>
      <h1>🛡️ Admin Console</h1>
      <p style={{ color: '#94a3b8', margin: '8px 0 24px' }}>Fraud detection monitoring & operations</p>
      <form onSubmit={submit}>
        <input style={inp} placeholder="Admin email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input style={inp} placeholder="Password" type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        {error && <p style={{ color: '#f871', margin: 8 }}>{error}</p>}
        <button style={{ ...btn, width: '100%', marginTop: 8, padding: 10 }} type="submit">Sign in</button>
      </form>
      <p style={{ color: '#64748b', fontSize: 12, marginTop: 16 }}>Default: admin@sentinelpay.local / Admin123!</p>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ ...card, flex: 1, textAlign: 'center', marginBottom: 0 }}>
      <div style={{ fontSize: 32, fontWeight: 700, color }}>{value}</div>
      <div style={{ color: '#94a3b8', fontSize: 13 }}>{label}</div>
    </div>
  );
}

function Dashboard({ token, user, onLogout }) {
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [txns, setTxns] = useState([]);
  const [liveFeed, setLiveFeed] = useState([]);
  const [tab, setTab] = useState('transactions');

  const refresh = async () => {
    try {
      const [s, u, t] = await Promise.all([
        api('/admin/stats', { token }), api('/admin/users', { token }), api('/admin/transactions', { token })
      ]);
      setStats(s); setUsers(u); setTxns(t);
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    socket = io('/', { withCredentials: true });
    socket.emit('join', { userId: user.id, role: 'admin' });
    socket.on('admin:txn', (txn) => setLiveFeed((prev) => [txn, ...prev].slice(0, 30)));
    socket.on('admin:alert', (a) => setLiveFeed((prev) => [{ ...a, _alert: true }, ...prev].slice(0, 30)));
    return () => { clearInterval(t); socket.disconnect(); };
  }, []);

  const setStatus = async (id, status) => { await api(`/admin/users/${id}/status`, { method: 'PATCH', token, body: { status } }); refresh(); };

  const riskColor = (p) => (p >= 0.7 ? '#f871' : p >= 0.3 ? '#fbbf24' : '#4ade80');
  const statusColor = { COMPLETED: '#4ade80', BLOCKED: '#f871', CHALLENGED: '#fbbf24', PENDING_RISK_CHECK: '#60a5fa' };

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1>🛡️ SentinelPay — Admin Console</h1>
        <div>
          <span style={{ marginRight: 16, color: '#94a3b8' }}>{user.email}</span>
          <button style={btn} onClick={() => { localStorage.clear(); onLogout(); }}>Logout</button>
        </div>
      </header>

      {stats && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
          <Stat label="Total transactions" value={stats.totalTx} color="#60a5fa" />
          <Stat label="Completed" value={stats.completed} color="#4ade80" />
          <Stat label="Challenged" value={stats.challenged} color="#fbbf24" />
          <Stat label="Blocked" value={stats.blocked} color="#f871" />
          <Stat label="Users" value={stats.users} color="#a78bfa" />
          <Stat label="Fraud alerts" value={stats.fraudAlerts} color="#fb923c" />
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        {['transactions', 'users', 'pipeline'].map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ ...btn, background: tab === t ? '#7c3aed' : '#1e293b', marginRight: 8, padding: '8px 20px' }}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {tab === 'transactions' && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div style={{ ...card, flex: 3 }}>
            <h3 style={{ marginBottom: 12 }}>All transactions</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>TxID</th><th style={th}>User</th><th style={th}>Amount</th><th style={th}>Status</th><th style={th}>Risk</th><th style={th}>Decision</th><th style={th}>Source</th><th style={th}>Reasons</th>
              </tr></thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t._id}>
                    <td style={td}>{t.txId}</td>
                    <td style={td}>{t.userId?.fullName || t.userId?.email || '—'}</td>
                    <td style={td}>${t.amount?.toFixed(2)}</td>
                    <td style={{ ...td, color: statusColor[t.status] || '#e2e8f0', fontWeight: 600 }}>{t.status}</td>
                    <td style={{ ...td, color: riskColor(t.fraudProbability || 0), fontWeight: 700 }}>
                      {t.fraudProbability != null ? `${Math.round(t.fraudProbability * 100)}%` : '—'}
                    </td>
                    <td style={td}>{t.decision || '—'}</td>
                    <td style={td}>{t.decisionSource || '—'}</td>
                    <td style={{ ...td, color: '#94a3b8', fontSize: 12 }}>{(t.reasons || []).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ ...card, flex: 1 }}>
            <h3 style={{ marginBottom: 12 }}>⚡ Live event feed</h3>
            {liveFeed.length === 0 && <p style={{ color: '#64748b' }}>Waiting for events…</p>}
            {liveFeed.map((e, i) => (
              <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid #1a2440', fontSize: 13 }}>
                {e._alert ? <span style={{ color: '#f871' }}>🚨 {e.title || 'Fraud alert'}</span>
                  : <span><b style={{ color: riskColor(e.fraudProbability || 0) }}>{e.txId}</b> ${e.amount} → {e.status}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'users' && (
        <div style={card}>
          <h3 style={{ marginBottom: 12 }}>User management</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Name</th><th style={th}>Email</th><th style={th}>Role</th><th style={th}>Status</th><th style={th}>Actions</th>
            </tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u._id}>
                  <td style={td}>{u.fullName}</td>
                  <td style={td}>{u.email}</td>
                  <td style={td}>{u.role}</td>
                  <td style={{ ...td, color: u.status === 'ACTIVE' ? '#4ade80' : u.status === 'BLOCKED' ? '#f871' : '#fbbf24', fontWeight: 600 }}>{u.status}</td>
                  <td style={td}>
                    {u.status !== 'ACTIVE' && <button style={{ ...btn, background: '#16a34a', marginRight: 6 }} onClick={() => setStatus(u._id, 'ACTIVE')}>Approve</button>}
                    {u.status === 'ACTIVE' && <button style={{ ...btn, background: '#64748b', marginRight: 6 }} onClick={() => setStatus(u._id, 'DISABLED')}>Disable</button>}
                    <button style={{ ...btn, background: '#dc2626' }} onClick={() => setStatus(u._id, 'BLOCKED')}>Block</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'pipeline' && (
        <div style={card}>
          <h3 style={{ marginBottom: 12 }}>Data pipeline & ML monitoring</h3>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, background: '#0a0f1e', borderRadius: 8, padding: 16 }}>
              <h4 style={{ color: '#fb923c' }}>🔥 Kafka</h4>
              <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 8 }}>Broker: localhost:9092</p>
              <p style={{ color: '#94a3b8', fontSize: 13 }}>Topics: txn.events.raw, txn.fraud.scored, txn.status.updates</p>
              <p style={{ color: '#94a3b8', fontSize: 13 }}>Kafka UI: <a style={{ color: '#60a5fa' }} href="http://localhost:8080" target="_blank">localhost:8080</a></p>
            </div>
            <div style={{ flex: 1, background: '#0a0f1e', borderRadius: 8, padding: 16 }}>
              <h4 style={{ color: '#60a5fa' }}>🪙 Delta Lake (Databricks)</h4>
              <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 8 }}>Bronze: fraud.analytics.bronze_events</p>
              <p style={{ color: '#94a3b8', fontSize: 13 }}>Silver: fraud.analytics.silver_events</p>
              <p style={{ color: '#94a3b8', fontSize: 13 }}>Gold: gold_user_behavior · gold_fraud_predictions · gold_fraud_kpis</p>
            </div>
            <div style={{ flex: 1, background: '#0a0f1e', borderRadius: 8, padding: 16 }}>
              <h4 style={{ color: '#4ade80' }}>🤖 Fraud model</h4>
              <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 8 }}>Engine: <a style={{ color: '#60a5fa' }} href="http://localhost:8000/health" target="_blank">localhost:8000/health</a></p>
              <p style={{ color: '#94a3b8', fontSize: 13 }}>MLflow: experiments/sentinelpay-fraud</p>
              <p style={{ color: '#94a3b8', fontSize: 13 }}>Champion selection: best PR-AUC</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('adminToken'));
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('adminUser') || 'null'));
  if (!token || !user) return <Login onAuth={(l) => { setToken(l.accessToken); setUser(l.user); }} />;
  return <Dashboard token={token} user={user} onLogout={() => { setToken(null); setUser(null); }} />;
}
