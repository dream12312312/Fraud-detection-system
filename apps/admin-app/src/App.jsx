import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import './styles.css';

const API = '';
let socket = null;
let accessToken = null;

function setSession(token, user_) {
  accessToken = token;
  if (token) localStorage.setItem('adminToken', token);
  else localStorage.removeItem('adminToken');
  if (user_) localStorage.setItem('adminUser', JSON.stringify(user_));
  else localStorage.removeItem('adminUser');
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error('Cannot reach the SentinelPay server (port 4000).');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const timeAgo = (iso) => {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
};

function Empty({ icon, title, text }) {
  return (
    <div className="empty">
      <div className="icon">{icon}</div>
      <h4>{title}</h4>
      <p>{text}</p>
    </div>
  );
}

const RiskBadge = ({ p }) => {
  if (p == null) return <span className="faint">—</span>;
  const cls = p >= 0.7 ? 'HIGH' : p >= 0.3 ? 'MEDIUM' : 'LOW';
  return <span className={`badge ${cls}`}>{Math.round(p * 100)}%</span>;
};

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
      onAuth(login.user);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="logo-big">🛡️</div>
        <h1>Admin Console</h1>
        <p className="sub">Fraud detection monitoring & operations</p>
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
        <div className="card-hint" style={{ textAlign: 'center', marginTop: 14 }}>Default: admin@sentinelpay.local / Admin123!</div>
      </div>
    </div>
  );
}

/* ---------- system status tile ---------- */

function StatusTile({ title, ico, ok, warn, detail }) {
  const dot = ok ? 'ok' : warn ? 'warn' : 'bad';
  const label = ok ? 'Operational' : warn ? 'Degraded' : 'Offline / not configured';
  return (
    <div className="card" style={{ marginTop: 0 }} title={detail}>
      <div className="card-title" style={{ marginBottom: 6 }}>
        <h3><span className="ico">{ico}</span> {title}</h3>
        <span className={`row muted`}><span className={`status-dot ${dot}`} /> {label}</span>
      </div>
      <div className="faint" style={{ fontSize: 12.5 }}>{detail}</div>
    </div>
  );
}

/* ---------- dashboard ---------- */

const TABS = [
  { id: 'transactions', ico: '💳', label: 'Transactions', hint: 'All transactions with fraud decisions' },
  { id: 'users', ico: '👥', label: 'Users', hint: 'Approve, block and review accounts' },
  { id: 'pipeline', ico: '⚙️', label: 'Data Processing', hint: 'Live pipeline monitoring: volumes, decisions, errors, Databricks' },
  { id: 'training', ico: '🧠', label: 'Model Training', hint: 'Start, track and review ML training runs (Databricks + MLflow)' },
  { id: 'system', ico: '📡', label: 'System', hint: 'Infrastructure status: Mongo, engine, Kafka, Databricks' }
];

/* ---------- shared bar chart (pure CSS, no dependency) ---------- */

function BarChart({ data, height = 140, colorVar = 'var(--accent)' }) {
  // data: [{ label, value, sub? }]
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="chart">
      {data.map((d, i) => (
        <div key={i} className="chart-col" title={`${d.label}: ${d.value}${d.sub ? ` · ${d.sub}` : ''}`}>
          <span className="chart-val" style={{ fontSize: 10, color: 'var(--text-dim)' }}>{d.value || ''}</span>
          <div className="chart-bar" style={{ height: `${Math.max((d.value / max) * (height - 40), d.value ? 3 : 1)}%`, background: colorVar }} />
          <span className="chart-label" style={{ fontSize: 10 }}>{d.label}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- data processing monitoring ---------- */

function PipelineTab({ pipeline }) {
  if (!pipeline) return <div className="card"><p style={{ color: 'var(--text-dim)' }}>Loading pipeline monitoring…</p></div>;
  const t = pipeline.totals24h ?? {};
  const series = pipeline.series ?? [];
  const txSeries = series.map((s) => ({ label: new Date(s.hour).getHours() + 'h', value: s.total, sub: `${s.completed}✓ ${s.challenged}⚠ ${s.blocked}⛔` }));
  const fraudSeries = series.map((s) => ({ label: new Date(s.hour).getHours() + 'h', value: s.blocked, sub: 'blocked' }));
  const mc = pipeline.databricks?.medallionCounts ?? {};
  const db = pipeline.databricks ?? {};
  return (
    <>
      <div className="page-head">
        <h2>Data processing monitoring</h2>
        <div className="sub">Real data only: MongoDB aggregates, fraud-engine health and live Databricks state. Refreshed every 5s.</div>
      </div>

      <div className="kpi-row" style={{ marginBottom: 18 }}>
        <div className="kpi"><div className="v">{t.processed ?? 0}</div><div className="l">⚙️ Processed (24h)</div></div>
        <div className="kpi"><div className="v" style={{ color: 'var(--success)' }}>{t.completed ?? 0}</div><div className="l">✅ Completed</div></div>
        <div className="kpi"><div className="v" style={{ color: 'var(--warn)' }}>{t.challenged ?? 0}</div><div className="l">⚠️ Under review</div></div>
        <div className="kpi"><div className="v" style={{ color: 'var(--danger)' }}>{t.blocked ?? 0}</div><div className="l">🚫 Blocked</div></div>
        <div className="kpi"><div className="v">{t.rejected ?? 0}</div><div className="l">⛔ Rejected / failed</div></div>
        <div className="kpi"><div className="v">{t.mlDecisions ?? 0}</div><div className="l">🤖 ML decisions</div></div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title"><h3><span className="ico">📈</span> Transactions per hour (24h)</h3></div>
          {txSeries.length === 0
            ? <Empty icon="📈" title="No traffic yet" text="Once transactions flow, hourly volume appears here." />
            : <BarChart data={txSeries} />}
        </div>
        <div className="card">
          <div className="card-title"><h3><span className="ico">🚨</span> Blocked per hour (24h)</h3></div>
          {fraudSeries.length === 0
            ? <Empty icon="🚨" title="Nothing blocked yet" text="Blocked transactions per hour will show here." />
            : <BarChart data={fraudSeries} colorVar="var(--danger)" />}
        </div>
      </div>

      <div className="grid cols-3" style={{ marginTop: 18 }}>
        <StatusTile ico="🗄️" title="Fraud engine" ok={pipeline.engine?.model_loaded} warn={!!pipeline.engine}
          detail={!pipeline.engine ? 'Fraud scoring engine offline — payments use local fallback rules.'
            : pipeline.engine.model_loaded ? `ML model active · ${pipeline.engine.features} features · scoring live.`
            : 'HEURISTIC mode — no trained model loaded.'} />
        <StatusTile ico="🔥" title="Kafka event backbone" ok={pipeline.kafka?.enabled} warn
          detail={pipeline.kafka?.enabled ? `Enabled — brokers ${pipeline.kafka?.brokers}` : 'Disabled (KAFKA_ENABLED=false) — events published in-process only.'} />
        <StatusTile ico="🪙" title="Databricks workspace" ok={db.configured} warn={db.host}
          detail={!db.configured ? 'Not configured — set DATABRICKS_HOST + DATABRICKS_TOKEN in .env.'
            : `Connected · catalog ${db.catalog} · volume ${db.volume}`} />
      </div>

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-title"><h3><span className="ico">🥉</span> Medallion layers (Databricks)</h3></div>
          <table className="data">
            <thead><tr><th>Layer</th><th>Table</th><th>Records</th></tr></thead>
            <tbody>
              {[['Bronze', 'bronze_events', mc.bronze_events], ['Silver', 'silver_events', mc.silver_events], ['Gold', 'gold_fraud_predictions', mc.gold_fraud_predictions], ['Gold KPI', 'gold_fraud_kpis', mc.gold_fraud_kpis]].map(([layer, tbl, n]) => (
                <tr key={tbl}><td>{layer}</td><td className="mono" style={{ fontSize: 12 }}>{db.catalog}.{tbl}</td><td>{n == null ? <span className="faint">n/a (no warehouse)</span> : n.toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
          {!db.warehouseConfigured && <div className="card-hint">Set DATABRICKS_WAREHOUSE_ID in .env to read live record counts from Unity Catalog.</div>}
        </div>
        <div className="card">
          <div className="card-title"><h3><span className="ico">✖️</span> Processing errors</h3></div>
          {pipeline.errors?.recent?.length === 0 || !pipeline.errors?.recent?.length
            ? <Empty icon="✅" title="No errors" text="No failed transactions recorded. Processing errors will appear here." />
            : pipeline.errors.recent.map((e, i) => (
              <div key={i} className="notif" style={{ padding: '8px 0' }}>
                <div className="title">⛔ {e.txId} · {money(e.amount)} · {(e.userId?.email || 'unknown user')}</div>
                <div className="time">{e.reasons?.join(', ') || e.status} · {timeAgo(e.createdAt)}</div>
              </div>
            ))}
        </div>
      </div>
    </>
  );
}

/* ---------- model training ---------- */

function TrainingTab({ training, mlflow, onStart }) {
  if (!training) return <div className="card"><p style={{ color: 'var(--text-dim)' }}>Loading training data…</p></div>;
  const current = training.current;
  const status = current?.status;
  const live = training.live;
  const last = training.lastCompleted;
  return (
    <>
      <div className="page-head">
        <h2>Model training</h2>
        <div className="sub">Training runs on Databricks compute and tracks results in Databricks-hosted MLflow. It is started manually — never automatically.</div>
      </div>

      <div className="grid cols-3">
        <div className="card">
          <div className="card-title"><h3><span className="ico">🧠</span> Current model</h3></div>
          <div className="review-row"><span className="k">Champion</span><b>{last?.championModel || (mlflow?.runs?.length ? 'ML model (Databricks MLflow)' : 'heuristic fallback')}</b></div>
          <div className="review-row"><span className="k">Last training</span><b>{last ? new Date(last.finishedAt || last.createdAt).toLocaleString() : 'never (in this DB)'}</b></div>
          <div className="review-row"><span className="k">Status</span>
            {status === 'RUNNING' && <span className="badge MEDIUM">{live ? `RUNNING (${live.state})` : 'RUNNING'}</span>}
            {status === 'COMPLETED' && <span className="badge LOW">COMPLETED</span>}
            {status === 'FAILED' && <span className="badge BLOCKED">FAILED</span>}
            {status === 'QUEUED' && <span className="badge INFO">QUEUED</span>}
            {!status && <span className="faint">no runs yet</span>}
          </div>
          {last?.metrics && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              <div className="review-row"><span className="k">Precision</span><b>{fmt(last.metrics.precision)}</b></div>
              <div className="review-row"><span className="k">Recall</span><b>{fmt(last.metrics.recall)}</b></div>
              <div className="review-row"><span className="k">F1</span><b>{fmt(last.metrics.f1)}</b></div>
              <div className="review-row"><span className="k">ROC-AUC</span><b>{fmt(last.metrics.rocAuc)}</b></div>
              <div className="review-row"><span className="k">PR-AUC</span><b>{fmt(last.metrics.prAuc)}</b></div>
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            <button className="btn" disabled={status === 'RUNNING' || status === 'QUEUED'} onClick={onStart}>🚀 Start Model Training</button>
            <div className="card-hint" style={{ marginTop: 8 }}>Before starting you will confirm that training uses Databricks compute (may incur costs).</div>
          </div>
        </div>

        <div className="card">
          <div className="card-title"><h3><span className="ico">🔬</span> Databricks MLflow</h3></div>
          {!mlflow?.experiment
            ? <Empty icon="🔬" title={mlflow?.configured ? 'Experiment not found' : 'Not configured'} text={mlflow?.configured ? 'No "sentinelpay-fraud" MLflow experiment exists yet — it is created on the first Databricks training run.' : 'Set DATABRICKS_HOST/TOKEN in .env to inspect the real MLflow workspace.'} />
            : (
              <>
                <div className="review-row"><span className="k">Experiment</span><b>{mlflow.experiment.name}</b></div>
                {mlflow.runs.length === 0 && <Empty icon="🔬" title="No MLflow runs" text="Runs appear here after the first Databricks training." />}
                {mlflow.runs.map((r) => (
                  <div key={r.runId} className="notif" style={{ padding: '8px 0' }}>
                    <div className="title">{r.status === 'FINISHED' ? '✅' : r.status === 'FAILED' ? '⛔' : '⏳'} {r.params?.model || r.params?.classifier || 'run'} · {timeAgo(r.startTime)}</div>
                    <div className="time">PR-AUC {fmt(r.metrics?.pr_auc)} · F1 {fmt(r.metrics?.f1)} · run {r.runId.slice(0, 8)}…</div>
                  </div>
                ))}
                {mlflow.modelVersions?.length > 0 && (
                  <>
                    <div className="section-label" style={{ margin: '12px 0 6px' }}>Registered model versions</div>
                    {mlflow.modelVersions.map((v) => (
                      <div key={v.version} className="notif" style={{ padding: '6px 0' }}>
                        <div className="title">{v.name} v{v.version} · {v.status}</div>
                        <div className="time">{timeAgo(v.createdAt)}</div>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
        </div>

        <div className="card">
          <div className="card-title"><h3><span className="ico">🕘</span> Training history</h3></div>
          {training.runs.length === 0
            ? <Empty icon="🕘" title="No training runs" text="Training never starts automatically. Use Start Model Training." />
            : training.runs.map((r) => (
              <div key={r._id} className="notif" style={{ padding: '8px 0' }}>
                <div className="title">
                  <span className={`badge ${r.status === 'COMPLETED' ? 'LOW' : r.status === 'FAILED' ? 'BLOCKED' : 'MEDIUM'}`}>{r.status}</span>
                  {r.championModel && <span style={{ marginLeft: 6 }}>{r.championModel}</span>}
                </div>
                <div className="time">
                  {timeAgo(r.createdAt)} · by {r.triggeredBy?.email || '—'}
                  {r.databricksRunId && <> · Databricks run {r.databricksRunId}</>}
                  {r.mlflowRunId && <> · MLflow {r.mlflowRunId.slice(0, 8)}…</>}
                </div>
              </div>
            ))}
        </div>
      </div>
    </>
  );
}

const fmt = (v) => (v == null ? '—' : Number(v).toFixed(4));

function Dashboard({ user, onLogout }) {
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [txns, setTxns] = useState([]);
  const [system, setSystem] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [training, setTraining] = useState(null);
  const [mlflow, setMlflow] = useState(null);
  const [liveFeed, setLiveFeed] = useState([]);
  const [tab, setTab] = useState('transactions');
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState(null); // user detail drawer data
  const [tempPwd, setTempPwd] = useState(null); // { user, password }

  const refresh = async () => {
    try {
      const q = statusFilter ? `?status=${statusFilter}` : '';
      const calls = [api('/admin/stats'), api(`/admin/users${q}`), api(`/admin/transactions${q}`), api('/admin/system')];
      if (tab === 'pipeline') calls.push(api('/admin/pipeline'));
      if (tab === 'training') calls.push(api('/admin/training'), api('/admin/training/mlflow'));
      const [s, u, t, sys, pipe, tr, ml] = await Promise.all(calls);
      setStats(s); setUsers(u); setTxns(t); setSystem(sys);
      if (pipe) setPipeline(pipe);
      if (tr) { setTraining(tr); await api('/admin/training/sync', { method: 'POST' }).catch(() => {}); }
      if (ml) setMlflow(ml);
      setError('');
    } catch (err) { setError(err.message); }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    socket = io('/', { withCredentials: true });
    socket.emit('join', { userId: user.id, role: 'admin' });
    socket.on('admin:txn', (txn) => setLiveFeed((prev) => [txn, ...prev].slice(0, 30)));
    socket.on('admin:alert', (a) => setLiveFeed((prev) => [{ ...a, _alert: true }, ...prev].slice(0, 30)));
    return () => { clearInterval(t); socket.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, statusFilter, tab]);

  // poll the tab-specific data more often than the base refresh
  useEffect(() => {
    if (tab !== 'pipeline' && tab !== 'training') return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const setStatus = async (id, status) => {
    try { await api(`/admin/users/${id}/status`, { method: 'PATCH', body: { status } }); refresh(); }
    catch (err) { setError(err.message); }
  };

  const setTempPassword = async (u) => {
    try {
      const r = await api(`/admin/users/${u._id}/temp-password`, { method: 'POST' });
      setTempPwd({ user: u, password: r.temporaryPassword, message: r.message });
      refresh();
    } catch (err) { setError(err.message); }
  };

  const openDetail = async (u) => {
    try { setDetail(await api(`/admin/users/${u._id}`)); }
    catch (err) { setError(err.message); }
  };

  const startTraining = async () => {
    if (!window.confirm('Model training will run on your Databricks workspace compute. This may incur usage costs. Start training now?')) return;
    setError('');
    try {
      await api('/admin/training/start', { method: 'POST', body: { confirm: true } });
      setTab('training');
      await refresh();
    } catch (err) { setError(err.message); }
  };

  const shownUsers = (pendingOnly ? users.filter((u) => u.status === 'PENDING') : users)
    .filter((u) => !search || u.fullName?.toLowerCase().includes(search.toLowerCase()) || u.email?.toLowerCase().includes(search.toLowerCase()));
  const pendingCount = stats?.pendingUsers ?? 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand"><span className="logo">🛡️</span> SentinelPay · Admin</div>
        <div className="topbar-user">
          <span>Signed in as <b>{user.email}</b></span>
          <button className="btn ghost sm" onClick={() => { setSession(null, null); onLogout(); }}>Sign out</button>
        </div>
      </header>

      <div className="layout">
        <nav className="side-nav">
          <div className="nav-label">Monitoring</div>
          {TABS.map((t) => (
            <button key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} title={t.hint}>
              <span className="nav-ico">{t.ico}</span>{t.label}
              {t.id === 'users' && pendingCount > 0 && <span className="nav-count" title={`${pendingCount} users awaiting approval`}>{pendingCount}</span>}
            </button>
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

        <main className="main">
          {error && <div className="flash error"><span>⛔</span><div>{error}</div></div>}

          {stats && (
            <div className="kpi-row" style={{ marginBottom: 18 }}>
              <div className="kpi" title="Total transactions processed"><div className="v">{stats.totalTx}</div><div className="l">💳 Total tx</div></div>
              <div className="kpi" title="Transactions completed after a low-risk decision"><div className="v" style={{ color: 'var(--success)' }}>{stats.completed}</div><div className="l">✅ Completed</div></div>
              <div className="kpi" title="Transactions flagged for step-up verification"><div className="v" style={{ color: 'var(--warn)' }}>{stats.challenged}</div><div className="l">⚠️ Challenged</div></div>
              <div className="kpi" title="Transactions blocked by the fraud engine"><div className="v" style={{ color: 'var(--danger)' }}>{stats.blocked}</div><div className="l">🚫 Blocked</div></div>
              <div className="kpi" title="Users awaiting approval — they cannot sign in until approved"><div className="v" style={{ color: pendingCount ? 'var(--warn)' : undefined }}>{pendingCount}</div><div className="l">⏳ Pending users</div></div>
              <div className="kpi" title="Fraud alerts raised on the platform"><div className="v">{stats.fraudAlerts}</div><div className="l">🚨 Fraud alerts</div></div>
            </div>
          )}

          {tab === 'transactions' && (
            <div className="grid sidebar" style={{ alignItems: 'flex-start' }}>
              <div className="card">
                <div className="card-title">
                  <h3><span className="ico">💳</span> All transactions</h3>
                  <select style={{ width: 'auto' }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} title="Filter by status">
                    <option value="">All statuses</option>
                    {['COMPLETED', 'CHALLENGED', 'BLOCKED', 'PENDING_RISK_CHECK', 'FAILED'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {txns.length === 0
                  ? <Empty icon="💳" title="No transactions" text="No transactions match this filter yet. They appear here the moment users pay or transfer." />
                  : (
                    <table className="data">
                      <thead><tr><th>TxID</th><th>User</th><th>Amount</th><th>Status</th><th>Risk</th><th>Decision</th><th>Source</th><th>Reasons</th></tr></thead>
                      <tbody>
                        {txns.map((t) => (
                          <tr key={t._id}>
                            <td className="mono">{t.txId}</td>
                            <td>{t.userId?.fullName || t.userId?.email || '—'}</td>
                            <td className="amount">{money(t.amount)}</td>
                            <td><span className={`badge ${t.status}`}>{t.status}</span></td>
                            <td><RiskBadge p={t.fraudProbability} /></td>
                            <td>{t.decision ? <span className={`badge ${t.decision === 'BLOCK' ? 'BLOCKED' : t.decision === 'REVIEW' ? 'MEDIUM' : 'LOW'}`}>{t.decision}</span> : '—'}</td>
                            <td className="faint" style={{ fontSize: 12 }}>{t.decisionSource || '—'}</td>
                            <td className="faint" style={{ fontSize: 12 }}>{(t.reasons || []).join(', ').replaceAll('_', ' ').toLowerCase() || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
              </div>

              <div className="card">
                <div className="card-title"><h3><span className="ico">⚡</span> Live event feed</h3></div>
                {liveFeed.length === 0
                  ? <Empty icon="⚡" title="Waiting for events" text="Live transactions and fraud alerts stream here in real time." />
                  : liveFeed.map((e, i) => (
                    <div key={i} className="notif clickable" style={{ padding: '9px 0' }}>
                      {e._alert
                        ? <div className="title" style={{ color: 'var(--danger)' }}>🚨 {e.title || 'Fraud alert'}</div>
                        : <div className="title"><b style={{ color: e.fraudProbability >= 0.7 ? 'var(--danger)' : e.fraudProbability >= 0.3 ? 'var(--warn)' : 'var(--success)' }}>{e.txId}</b> {money(e.amount)} → <span className={`badge ${e.status}`}>{e.status}</span></div>}
                      <div className="time">{timeAgo(e.createdAt || new Date())}</div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {tab === 'users' && (
            <>
            <div className="card">
              <div className="card-title">
                <h3><span className="ico">👥</span> User management</h3>
                <div className="row" style={{ gap: 8 }}>
                  <input placeholder="Search name or email…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 200 }} />
                  <button className="btn ghost sm" onClick={() => setPendingOnly((v) => !v)} title="Show only users who cannot sign in yet">
                    {pendingOnly ? 'Showing pending only' : `Pending${pendingCount ? ` (${pendingCount})` : ''}`}
                  </button>
                </div>
              </div>
              {shownUsers.length === 0
                ? <Empty icon="👥" title={search ? 'No matches' : pendingOnly ? 'No pending users' : 'No users'} text={search ? 'Try a different search term.' : pendingOnly ? 'Every registered user has been reviewed. New sign-ups awaiting approval will appear here.' : 'No registered users yet.'} />
                : (
                  <table className="data">
                    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th style={{ width: 330 }}>Actions</th></tr></thead>
                    <tbody>
                      {shownUsers.map((u) => (
                        <tr key={u._id}>
                          <td><b>{u.fullName}</b></td>
                          <td>{u.email}</td>
                          <td className="faint">{u.role}</td>
                          <td>
                            <span className={`badge ${u.status}`}>{u.status === 'PENDING' ? 'PENDING APPROVAL' : u.status}</span>
                            {u.mustChangePassword && <span className="badge MEDIUM" style={{ marginLeft: 6 }} title="This user must change the temporary password at next sign-in">TEMP PWD</span>}
                          </td>
                          <td className="faint" style={{ whiteSpace: 'nowrap' }}>{new Date(u.createdAt).toLocaleDateString()}</td>
                          <td>
                            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                              <button className="btn ghost sm" onClick={() => openDetail(u)} title="Open user details and transaction history">Details</button>
                              {u.status !== 'ACTIVE' && u.role === 'user' && (
                                <button className="btn success sm" title="Approve this account so the user can sign in and bank" onClick={() => setStatus(u._id, 'ACTIVE')}>Approve</button>
                              )}
                              {u.status === 'ACTIVE' && (
                                <button className="btn ghost sm" title="Disable the account — the user cannot sign in" onClick={() => setStatus(u._id, 'DISABLED')}>Disable</button>
                              )}
                              {u.status !== 'BLOCKED' && (
                                <button className="btn danger sm" title="Block the account for suspected fraud or abuse" onClick={() => setStatus(u._id, 'BLOCKED')}>Block</button>
                              )}
                              <button className="btn sm" title="Generate a temporary password. It is hashed before storage; the user must change it at next sign-in." onClick={() => setTempPassword(u)}>Set temp password</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>

            {detail && (
              <div className="modal-overlay" onClick={() => setDetail(null)}>
                <div className="modal" style={{ minWidth: 640 }} onClick={(e) => e.stopPropagation()}>
                  <div className="card-title">
                    <h3>👤 {detail.user.fullName}</h3>
                    <button className="btn ghost sm" onClick={() => setDetail(null)}>✕</button>
                  </div>
                  <div className="review-row"><span className="k">Email</span><b>{detail.user.email}</b></div>
                  <div className="review-row"><span className="k">Status</span><span className={`badge ${detail.user.status}`}>{detail.user.status}</span></div>
                  <div className="review-row"><span className="k">Role</span><b>{detail.user.role}</b></div>
                  {detail.accounts.map((a) => (
                    <div key={a._id} className="review-row"><span className="k">{a.type} · {a.accountNumber}</span><b>{money(a.balance)}</b></div>
                  ))}
                  <div className="section-label" style={{ margin: '14px 0 8px' }}>Transaction history ({detail.transactions.length})</div>
                  {detail.transactions.length === 0
                    ? <Empty icon="🧾" title="No transactions" text="This user has not transacted yet." />
                    : (
                      <table className="data">
                        <thead><tr><th>Date</th><th>TxID</th><th>Amount</th><th>Status</th><th>Risk</th></tr></thead>
                        <tbody>
                          {detail.transactions.slice(0, 15).map((t) => (
                            <tr key={t._id}>
                              <td className="faint" style={{ whiteSpace: 'nowrap' }}>{new Date(t.createdAt).toLocaleString()}</td>
                              <td className="mono" style={{ fontSize: 12 }}>{t.txId}</td>
                              <td className="amount">{money(t.amount)}</td>
                              <td><span className={`badge ${t.status}`}>{t.status}</span></td>
                              <td><RiskBadge p={t.fraudProbability} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  <div className="actions" style={{ marginTop: 14 }}>
                    <button className="btn sm" onClick={() => { setTempPassword(detail.user); setDetail(null); }}>Set temp password</button>
                    {detail.user.status === 'BLOCKED' && <button className="btn success sm" onClick={() => { setStatus(detail.user._id, 'ACTIVE'); setDetail(null); }}>Unblock</button>}
                  </div>
                </div>
              </div>
            )}

            {tempPwd && (
              <div className="modal-overlay" onClick={() => setTempPwd(null)}>
                <div className="modal" style={{ minWidth: 480 }} onClick={(e) => e.stopPropagation()}>
                  <h3>🔑 Temporary password created</h3>
                  <p style={{ color: 'var(--text-dim)', fontSize: 13.5 }}>For <b>{tempPwd.user.email}</b>. This is shown <b>once</b> — it is stored only as a bcrypt hash and can never be displayed again.</p>
                  <div className="mono temp-pwd-box">{tempPwd.password}</div>
                  <div className="flash warn" style={{ marginTop: 12 }}><span>⚠️</span><div>The user will be forced to change this password at next sign-in. Share it through a secure channel (never email in plain text).</div></div>
                  <div className="actions">
                    <button className="btn success" onClick={() => { navigator.clipboard?.writeText(tempPwd.password); }}>Copy</button>
                    <button className="btn" onClick={() => setTempPwd(null)}>Done</button>
                  </div>
                </div>
              </div>
            )}
            </>
          )}

          {tab === 'pipeline' && <PipelineTab pipeline={pipeline} />}

          {tab === 'training' && (
            <TrainingTab training={training} mlflow={mlflow} onStart={startTraining} />
          )}

          {tab === 'system' && (
            <>
              <div className="page-head">
                <h2>System & pipeline status</h2>
                <div className="sub">Live indicators for the data pipeline, fraud model and Databricks wiring. Refreshed every 10 seconds.</div>
              </div>
              <div className="grid cols-3">
                <StatusTile
                  ico="🗄️" title="MongoDB" ok={system?.mongo?.connected}
                  detail={system?.mongo?.connected ? 'Connected — application database operational.' : 'Database not reachable.'}
                />
                <StatusTile
                  ico="🤖" title="Fraud ML model" ok={system?.fraudEngine?.reachable && system?.fraudEngine?.modelLoaded} warn={system?.fraudEngine?.reachable}
                  detail={
                    !system?.fraudEngine?.reachable ? `Engine not reachable at ${system?.fraudEngine?.url || 'localhost:8000'}.`
                      : system?.fraudEngine?.modelLoaded ? `Trained model loaded (${system?.fraudEngine?.features} features). Real-time scoring active.`
                      : 'Engine up but running in HEURISTIC fallback mode — train the model (services/ml/train_model.py).'
                  }
                />
                <StatusTile
                  ico="🔥" title="Kafka events" ok={system?.kafka?.enabled} warn
                  detail={system?.kafka?.enabled ? `Enabled — brokers ${system?.kafka?.brokers}.` : 'Kafka disabled (.env KAFKA_ENABLED=false) — events are published in-process only.'}
                />
                <StatusTile
                  ico="🪙" title="Databricks connection" ok={system?.databricks?.hostConfigured && system?.databricks?.tokenConfigured} warn={system?.databricks?.hostConfigured}
                  detail={
                    !system?.databricks?.hostConfigured ? 'DATABRICKS_HOST not set — lake ingest bridge will not start.'
                      : !system?.databricks?.tokenConfigured ? 'DATABRICKS_TOKEN missing — set it in .env.'
                      : `Host configured. Landing volume ${system?.databricks?.volume}. Catalog ${system?.databricks?.catalog}.${system?.databricks?.schema}.`
                  }
                />
              </div>
              {system && (
                <div className="card" style={{ marginTop: 18 }}>
                  <div className="card-title"><h3><span className="ico">🪙</span> Medallion tables (Databricks)</h3></div>
                  <table className="data">
                    <thead><tr><th>Layer</th><th>Table</th><th>Contents</th></tr></thead>
                    <tbody>
                      <tr><td><span className="badge LOW">Bronze</span></td><td className="mono">{system?.databricks?.catalog}.{system?.databricks?.schema}.bronze_events</td><td className="faint">Raw transaction events as ingested</td></tr>
                      <tr><td><span className="badge INFO">Silver</span></td><td className="mono">{system?.databricks?.catalog}.{system?.databricks?.schema}.silver_events</td><td className="faint">Cleaned, typed transactions</td></tr>
                      <tr><td><span className="badge MEDIUM">Gold</span></td><td className="mono">gold_fraud_predictions</td><td className="faint">transaction_id · user_id · amount · risk_score · decision · timestamp</td></tr>
                    </tbody>
                  </table>
                  <div className="card-hint">Run the Databricks notebooks (01_bronze → 02_silver → 03_gold) and the lake ingest bridge to populate these tables.</div>
                </div>
              )}
            </>
          )}
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

  // Verify the stored admin session with the server before trusting it —
  // without this, a stale/expired token renders the dashboard silently.
  useEffect(() => {
    if (!token) { setBooting(false); return; }
    accessToken = token;
    api('/auth/me').then((me) => {
      if (me?.role !== 'admin') { setSession(null, null); setUser(null); setToken(null); }
      else setUser(me);
    }).catch(() => { setSession(null, null); setUser(null); setToken(null); })
      .finally(() => setBooting(false));
  }, []);

  if (booting) {
    return (
      <div className="auth-wrap">
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
