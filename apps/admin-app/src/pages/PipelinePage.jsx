import React, { useState } from 'react';
import { api } from '../api.js';
import { useAdminData, useAction, PageHead, Empty, Confirm, ExtLink, int, timeAgo } from '../ui.jsx';
import { StageMap, Reconciliation, RunTimeline } from '../flow.jsx';

export const taskTone = (t) => (!t ? 'idle' : t.result === 'SUCCESS' ? 'ok' : t.result ? 'error' : ['RUNNING', 'PENDING', 'QUEUED'].includes(t.state) ? 'running' : 'idle');
const TABLES = [
  ['Bronze', 'bronze_events', 'Raw events exactly as landed (append-only)'],
  ['Silver', 'silver_events', 'Typed, validated, de-duplicated'],
  ['Silver · quarantine', 'silver_quarantine', 'Rows that failed the data contract'],
  ['Gold', 'gold_fraud_predictions', 'Every fraud decision + transaction facts'],
  ['Gold', 'gold_fraud_kpis', 'Hourly fraud KPIs'],
  ['Gold', 'gold_user_behavior', 'Per-user behaviour features'],
  ['ML', 'ml_dataset', 'Latest training dataset snapshot'],
  ['ML', 'ml_features', 'Latest engineered features + split']
];

export default function PipelinePage({ flash, go }) {
  const { data, reload } = useAdminData({ pipeline: '/admin/pipeline', flow: '/admin/dataflow' }, 8000);
  const [busy, run] = useAction(flash);
  const [confirmRun, setConfirmRun] = useState(false);
  const p = data.pipeline;
  const flow = data.flow;
  if (!p) return <div className="card"><p className="faint">Loading pipeline…</p></div>;

  const db = p.databricks ?? {};
  const host = db.host;
  const mc = db.medallionCounts ?? {};
  const lake = p.lakehouse ?? {};
  const job = (db.jobs || []).find((j) => j.name?.includes('medallion'));
  const latest = job?.latestRun;
  const running = ['PENDING', 'QUEUED', 'RUNNING'].includes(latest?.state);
  const waiting = latest?.tasks?.find((t) => t.message && t.state !== 'TERMINATED');

  const land = () => run('land', () => api('/admin/lakehouse/land', { method: 'POST' }), (r) => r.rows ? `Landed ${r.rows} transaction(s) → ${r.path.split('/').slice(-2).join('/')}` : r.message).then(reload);
  const runPipeline = () => run('run', () => api('/admin/databricks/pipeline/run', { method: 'POST', body: { confirm: true } }), 'Pipeline started on Databricks.').then(() => { setConfirmRun(false); reload(); });

  return (
    <>
      <PageHead title="Data pipeline" sub="MongoDB → landing volume → Bronze → Silver → Gold. Counts, backlogs and timings are read live from MongoDB, the Databricks Jobs API and Unity Catalog.">
        <button className="btn sm ghost" disabled={!!busy || !lake.pending} onClick={land} title="Export settled transactions as NDJSON into the landing volume">{busy === 'land' ? 'Landing…' : `📦 Land ${lake.pending || 0} new`}</button>
        {job
          ? <button className="btn sm" disabled={!!busy || running} onClick={() => setConfirmRun(true)}>{running ? 'Running on Databricks…' : '▶ Run pipeline'}</button>
          : <button className="btn sm" onClick={() => go('databricks')}>Set up Databricks</button>}
      </PageHead>

      <div className="card">
        <div className="card-title">
          <h3><span className="ico">🌊</span> Where the data is now</h3>
          <span className="faint" style={{ fontSize: 12 }}>blocks between stages are rows waiting for the next step</span>
        </div>
        <StageMap flow={flow} />
        {waiting && <div className="card-hint">Databricks says: {waiting.message}</div>}
      </div>

      <div className="card" style={{ marginTop: 18 }}>
          <div className="card-title"><h3><span className="ico">🔀</span> Where the rows went · last successful run</h3></div>
          {flow ? <Reconciliation rec={flow.reconciliation} /> : <p className="faint">Loading…</p>}
          <div className="card-hint">Numbers are the notebooks’ own exit values (bronze / silver / gold task outputs), checked against each other.</div>
      </div>
      <div className="card" style={{ marginTop: 18 }}>
          <div className="card-title">
            <h3><span className="ico">⏱️</span> Run timeline</h3>
            <ExtLink href={host && job && `${host}/jobs/${job.jobId}`}>Job in Databricks</ExtLink>
          </div>
          {flow?.runs ? <RunTimeline runs={flow.runs} order={['bronze', 'silver', 'gold']} host={host} jobId={job?.jobId} />
            : job ? <p className="faint">Loading…</p> : <Empty icon="🧱" title="Job not deployed" text="Set it up on the Databricks page." />}
          <div className="card-hint">Grey is time spent waiting for serverless compute before the first task starts.</div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-title"><h3><span className="ico">📦</span> Landing files</h3><span className="mono faint" style={{ fontSize: 11.5 }}>{lake.volume}</span></div>
          {lake.recent?.length ? (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>File</th><th>Rows</th><th>Size</th><th>When</th></tr></thead>
              <tbody>{lake.recent.map((b) => (
                <tr key={b._id}><td className="mono" title={b.path}>{b.error ? <span style={{ color: 'var(--danger)' }}>failed: {b.error}</span> : b.path.split('/').slice(-2).join('/')}</td><td>{b.rows}</td><td className="faint">{b.bytes ? `${(b.bytes / 1024).toFixed(1)} KB` : '—'}</td><td className="faint">{timeAgo(b.createdAt)}</td></tr>
              ))}</tbody>
            </table></div>
          ) : <Empty icon="📦" title="Nothing landed yet" text="Press “Land” to export settled transactions." />}
          <div className="card-hint">{p.kafka?.enabled ? 'The Kafka bridge also writes into this volume.' : 'Kafka is off, so this export is the ingestion path.'}</div>
        </div>
        <div className="card">
          <div className="card-title"><h3><span className="ico">🗃️</span> Lakehouse tables</h3><span className="mono faint" style={{ fontSize: 11.5 }}>{db.catalog}</span></div>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Layer</th><th>Table</th><th>Contents</th><th style={{ textAlign: 'right' }}>Rows</th></tr></thead>
            <tbody>{TABLES.map(([layer, tbl, what]) => (
              <tr key={tbl}>
                <td><span className={`layer-tag ${layer.split(' ')[0].toLowerCase()}`}>{layer}</span></td>
                <td>{host ? <a className="mono" href={`${host}/explore/data/${(db.catalog || 'fraud.analytics').replace('.', '/')}/${tbl}`} target="_blank" rel="noopener noreferrer">{tbl}</a> : <span className="mono">{tbl}</span>}</td>
                <td className="faint">{what}</td>
                <td className="amount" style={{ textAlign: 'right' }}>{mc[tbl] == null ? <span className="faint">not created</span> : int(mc[tbl])}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="card-hint">Row counts via the SQL warehouse, cached 5 min and refreshed when a job finishes.</div>
        </div>
      </div>

      {confirmRun && (
        <Confirm title="Run the medallion pipeline?" confirmLabel="Run on Databricks" busy={busy === 'run'} onCancel={() => setConfirmRun(false)} onConfirm={runPipeline}>
          Starts <b>{job?.name}</b> on Databricks serverless compute (uses workspace compute; about 2–3 minutes). Bronze picks up every file landed since the last run.
        </Confirm>
      )}
    </>
  );
}
