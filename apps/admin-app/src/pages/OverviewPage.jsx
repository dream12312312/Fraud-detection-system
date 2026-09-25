import React from 'react';
import { useAdminData, Kpi, PageHead, int, money, timeAgo, Empty } from '../ui.jsx';
import { StageMap } from '../flow.jsx';

/**
 * Landing page: the data platform in one screen. The stage map follows the
 * payment data from MongoDB to Gold with real counts, backlogs and freshness.
 */
export default function OverviewPage({ go, liveFeed }) {
  const { data } = useAdminData({ stats: '/admin/stats', system: '/admin/system', pipeline: '/admin/pipeline', training: '/admin/training', flow: '/admin/dataflow' }, 10000);
  const { stats, system, pipeline, training, flow } = data;
  const lake = pipeline?.lakehouse;
  const jobs = pipeline?.databricks?.jobs ?? [];
  const medJob = jobs.find((j) => j.name?.includes('medallion'));
  const fe = system?.fraudEngine;
  const cur = training?.current;


  const todo = [
    stats?.pendingUsers > 0 && { ico: '⏳', text: `${stats.pendingUsers} user(s) waiting for approval`, go: 'users' },
    stats?.challenged > 0 && { ico: '⚠️', text: `${stats.challenged} transaction(s) waiting for confirmation`, go: 'transactions' },
    flow?.goldBehind > 0 && { ico: '📦', text: `Gold is behind by ${flow.goldBehind} payment(s): ${lake?.pending ? `${lake.pending} not landed` : ''}${lake?.pending && flow.goldBehind > lake.pending ? ' · ' : ''}${flow.goldBehind > (lake?.pending || 0) ? `${flow.goldBehind - (lake?.pending || 0)} landed, waiting for a pipeline run` : ''}`, go: 'pipeline' },
    flow?.hot?.stuck > 0 && { ico: '🧊', text: `${flow.hot.stuck} payment(s) stuck before scoring (hold still placed)`, go: 'transactions' },
    pipeline && !medJob && { ico: '🧱', text: 'Databricks jobs are not deployed yet', go: 'databricks' },
    fe && !fe.reachable && { ico: '🛑', text: 'Fraud engine offline — payments use fallback rules', go: 'system' },
    cur?.status === 'FAILED' && { ico: '⛔', text: `Last training run failed: ${cur.stateMessage || ''}`.slice(0, 120), go: 'training' }
  ].filter(Boolean);

  return (
    <>
      <PageHead title="From payment to prediction" sub="Every transfer is scored in real time, landed in the Databricks lakehouse, refined through Bronze → Silver → Gold, and used to train the next fraud model.">
        <button className="btn sm" onClick={() => go('architecture')}>Open live data flow</button>
        <button className="btn ghost sm" onClick={() => go('pipeline')}>Data pipeline</button>
        <button className="btn ghost sm" onClick={() => go('training')}>Train a model</button>
      </PageHead>

      <div className="card">
        <div className="card-title"><h3><span className="ico">🌊</span> Data flow</h3><button className="btn ghost sm" onClick={() => go('pipeline')}>Details</button></div>
        <StageMap flow={flow} compact />
      </div>

      <div className="kpi-row" style={{ margin: '18px 0' }}>
        <Kpi label="💳 Transactions" value={int(stats?.totalTx)} onClick={() => go('transactions')} />
        <Kpi label="✅ Completed" value={int(stats?.completed)} tone="success" />
        <Kpi label="⚠️ Challenged" value={int(stats?.challenged)} tone="warn" />
        <Kpi label="🚫 Blocked" value={int(stats?.blocked)} tone="danger" />
        <Kpi label="👥 Users" value={int(stats?.users)} onClick={() => go('users')} />
        <Kpi label="🧠 Live model" value={fe ? (fe.mode === 'ML_MODEL' ? 'ML model' : fe.reachable ? 'Base (rules)' : 'Offline') : '…'} tone={fe && !fe.reachable ? 'danger' : undefined} hint={cur ? `latest training: ${cur.modelType} · ${cur.status}` : 'no training run yet'} onClick={() => go('training')} />
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
