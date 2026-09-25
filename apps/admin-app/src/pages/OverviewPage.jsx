import React from 'react';
import { useAdminData, Kpi, int, money, timeAgo, Empty } from '../ui.jsx';
import { PipelineArt } from '../illustrations.jsx';

/**
 * Landing page: the data platform in one screen. The flow strip follows one
 * transaction's data from MongoDB to the model, with real counts at each hop.
 */
export default function OverviewPage({ go, liveFeed }) {
  const { data } = useAdminData({ stats: '/admin/stats', system: '/admin/system', pipeline: '/admin/pipeline', training: '/admin/training' }, 10000);
  const { stats, system, pipeline, training } = data;
  const mc = pipeline?.databricks?.medallionCounts ?? {};
  const lake = pipeline?.lakehouse;
  const jobs = pipeline?.databricks?.jobs ?? [];
  const medJob = jobs.find((j) => j.name?.includes('medallion'));
  const fe = system?.fraudEngine;
  const cur = training?.current;

  const flow = [
    { id: 'mongo', ico: '🗄️', title: 'Operational DB', value: int(system?.counts?.totalTx), unit: 'transactions', tone: system?.mongo?.connected ? 'ok' : 'bad', note: 'MongoDB · system of record', go: 'transactions' },
    { id: 'land', ico: '📦', title: 'Landing volume', value: int(lake?.landed), unit: 'rows landed', tone: lake ? (lake.pending ? 'warn' : 'ok') : 'idle', note: lake ? `${lake.pending} waiting to land` : '…', go: 'pipeline' },
    { id: 'bronze', ico: '🥉', title: 'Bronze', value: int(mc.bronze_events), unit: 'raw events', tone: mc.bronze_events != null ? 'ok' : 'idle', note: 'Auto Loader ingest', go: 'pipeline' },
    { id: 'silver', ico: '🥈', title: 'Silver', value: int(mc.silver_events), unit: 'clean events', tone: mc.silver_events != null ? 'ok' : 'idle', note: `${int(mc.silver_quarantine)} quarantined`, go: 'pipeline' },
    { id: 'gold', ico: '🥇', title: 'Gold', value: int(mc.gold_fraud_predictions), unit: 'predictions', tone: mc.gold_fraud_predictions != null ? 'ok' : 'idle', note: `${int(mc.gold_user_behavior)} user profiles`, go: 'pipeline' },
    { id: 'model', ico: '🧠', title: 'Model', value: cur?.modelType ? cur.modelType.replaceAll('_', ' ') : '—', unit: !training ? 'loading…' : cur ? `${cur.status.toLowerCase()}${cur.dataset ? ` · ${cur.dataset.replaceAll('_', ' ')}` : ''}` : 'never trained', tone: cur?.status === 'COMPLETED' ? 'ok' : cur?.status === 'FAILED' ? 'bad' : cur ? 'run' : 'idle', note: `live: ${fe?.mode === 'ML_MODEL' ? 'ML model' : fe?.reachable ? 'base model (rules)' : 'engine offline'}`, go: 'training' }
  ];

  const todo = [
    stats?.pendingUsers > 0 && { ico: '⏳', text: `${stats.pendingUsers} user(s) waiting for approval`, go: 'users' },
    stats?.challenged > 0 && { ico: '⚠️', text: `${stats.challenged} transaction(s) waiting for confirmation`, go: 'transactions' },
    lake?.pending > 0 && { ico: '📦', text: `${lake.pending} settled transaction(s) not yet in the lakehouse`, go: 'pipeline' },
    pipeline && !medJob && { ico: '🧱', text: 'Databricks jobs are not deployed yet', go: 'databricks' },
    fe && !fe.reachable && { ico: '🛑', text: 'Fraud engine offline — payments use fallback rules', go: 'system' },
    cur?.status === 'FAILED' && { ico: '⛔', text: `Last training run failed: ${cur.stateMessage || ''}`.slice(0, 120), go: 'training' }
  ].filter(Boolean);

  return (
    <>
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="eyebrow">Data engineering platform</div>
          <h1>From payment to prediction</h1>
          <p>Every transfer is scored in real time, landed in the Databricks lakehouse, refined through Bronze → Silver → Gold, and used to train the next fraud model.</p>
          <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => go('architecture')}>Open 3D architecture</button>
            <button className="btn ghost sm" onClick={() => go('pipeline')}>Data pipeline</button>
            <button className="btn ghost sm" onClick={() => go('training')}>Train a model</button>
          </div>
        </div>
        <PipelineArt className="hero-art" />
      </section>

      <div className="flow-strip">
        {flow.map((s, i) => (
          <React.Fragment key={s.id}>
            {i > 0 && <div className="flow-arrow" aria-hidden="true" />}
            <button className={`flow-step ${s.tone}`} onClick={() => go(s.go)} title={`Open ${s.title}`}>
              <div className="flow-top"><span className="flow-ico">{s.ico}</span><span className={`sdot ${s.tone}`} /></div>
              <div className="flow-title">{s.title}</div>
              <div className="flow-value">{s.value}</div>
              <div className="flow-unit">{s.unit}</div>
              <div className="flow-note">{s.note}</div>
            </button>
          </React.Fragment>
        ))}
      </div>

      <div className="kpi-row" style={{ margin: '18px 0' }}>
        <Kpi label="💳 Transactions" value={int(stats?.totalTx)} onClick={() => go('transactions')} />
        <Kpi label="✅ Completed" value={int(stats?.completed)} tone="success" />
        <Kpi label="⚠️ Challenged" value={int(stats?.challenged)} tone="warn" />
        <Kpi label="🚫 Blocked" value={int(stats?.blocked)} tone="danger" />
        <Kpi label="👥 Users" value={int(stats?.users)} onClick={() => go('users')} />
        <Kpi label="🚨 Fraud alerts" value={int(stats?.fraudAlerts)} />
      </div>

      <div className="grid sidebar">
        <div className="card">
          <div className="card-title"><h3><span className="ico">⚡</span> Live transactions</h3><span className="faint" style={{ fontSize: 12 }}>real-time over Socket.IO</span></div>
          {liveFeed.length === 0
            ? <Empty icon="⚡" title="Waiting for events" text="Transactions appear here the moment a user pays or transfers." />
            : (
              <table className="data">
                <thead><tr><th>Tx</th><th>Amount</th><th>Status</th><th>Risk</th><th>When</th></tr></thead>
                <tbody>
                  {liveFeed.filter((e) => !e._alert).slice(0, 8).map((e, i) => (
                    <tr key={i}>
                      <td className="mono">{e.txId}</td>
                      <td className="amount">{money(e.amount)}</td>
                      <td><span className={`badge ${e.status}`}>{e.status}</span></td>
                      <td>{e.fraudProbability == null ? '—' : `${Math.round(e.fraudProbability * 100)}%`}</td>
                      <td className="faint">{timeAgo(e._at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
        <div className="card">
          <div className="card-title"><h3><span className="ico">📋</span> Needs attention</h3></div>
          {todo.length === 0
            ? <Empty icon="✨" title="All clear" text="No pending approvals, stuck payments or pipeline backlog." />
            : todo.map((t, i) => (
              <button key={i} className="todo" onClick={() => go(t.go)}>
                <span>{t.ico}</span><span style={{ flex: 1 }}>{t.text}</span><span className="faint">›</span>
              </button>
            ))}
        </div>
      </div>
    </>
  );
}
