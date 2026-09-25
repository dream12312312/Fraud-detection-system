import React, { useState } from 'react';
import { api } from '../api.js';
import { useAdminData, useAction, PageHead, Empty, BarChart, Confirm, Kpi, StateDot, ExtLink, int, timeAgo, duration } from '../ui.jsx';
import { LakehouseArt } from '../illustrations.jsx';

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

function Step({ n, title, sub, state, children, actions }) {
  return (
    <section className={`pstep ${state}`}>
      <div className="pstep-rail"><div className="pstep-n">{n}</div></div>
      <div className="card pstep-card">
        <div className="card-title" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div><h3 className="row" style={{ gap: 8 }}><StateDot state={state} /> {title}</h3>{sub && <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>{sub}</div>}</div>
          {actions && <div className="row" style={{ gap: 8 }}>{actions}</div>}
        </div>
        {children}
      </div>
    </section>
  );
}

export default function PipelinePage({ flash, go }) {
  const { data, reload } = useAdminData({ pipeline: '/admin/pipeline' }, 6000);
  const [busy, run] = useAction(flash);
  const [confirmRun, setConfirmRun] = useState(false);
  const p = data.pipeline;
  if (!p) return <div className="card"><p className="faint">Loading pipeline…</p></div>;

  const db = p.databricks ?? {};
  const host = db.host;
  const mc = db.medallionCounts ?? {};
  const lake = p.lakehouse ?? {};
  const job = (db.jobs || []).find((j) => j.name?.includes('medallion'));
  const latest = job?.latestRun;
  const running = ['PENDING', 'QUEUED', 'RUNNING'].includes(latest?.state);
  const t = p.totals24h ?? {};
  const series = p.series ?? [];

  const land = () => run('land', () => api('/admin/lakehouse/land', { method: 'POST' }), (r) => r.rows ? `Landed ${r.rows} transaction(s) → ${r.path.split('/').slice(-2).join('/')}` : r.message).then(reload);
  const runPipeline = () => run('run', () => api('/admin/databricks/pipeline/run', { method: 'POST', body: { confirm: true } }), 'Pipeline started on Databricks.').then(() => { setConfirmRun(false); reload(); });

  return (
    <>
      <section className="hero-panel slim">
        <div className="hero-copy">
          <div className="eyebrow">Data engineering</div>
          <h1>Data pipeline</h1>
          <p>MongoDB → landing volume → Bronze → Silver → Gold. Each step below shows its real state and lets you move data to the next one.</p>
        </div>
        <LakehouseArt className="hero-art" />
      </section>

      <div className="kpi-row" style={{ marginBottom: 18 }}>
        <Kpi label="Processed 24h" value={int(t.processed)} />
        <Kpi label="Waiting to land" value={int(lake.pending)} tone={lake.pending ? 'warn' : undefined} />
        <Kpi label="Bronze rows" value={int(mc.bronze_events)} />
        <Kpi label="Silver rows" value={int(mc.silver_events)} />
        <Kpi label="Quarantined" value={int(mc.silver_quarantine)} tone={mc.silver_quarantine ? 'warn' : undefined} />
        <Kpi label="Gold predictions" value={int(mc.gold_fraud_predictions)} />
      </div>

      <div className="psteps">
        <Step n="1" title="Operational source · MongoDB" state="ok" sub="Every payment is written here first, with its fraud decision and the features that were scored.">
          <div className="grid cols-2">
            <div>
              <div className="section-label" style={{ marginTop: 0 }}>Transactions per hour (24h)</div>
              {series.length ? <BarChart height={130} data={series.map((s) => ({ label: `${new Date(s.hour).getHours()}h`, value: s.total, sub: `${s.completed}✓ ${s.challenged}⚠ ${s.blocked}⛔` }))} />
                : <Empty icon="📈" title="No traffic in 24h" text="Hourly volume appears once payments flow." />}
            </div>
            <div>
              <div className="section-label" style={{ marginTop: 0 }}>Blocked per hour (24h)</div>
              {series.length ? <BarChart height={130} color="var(--danger)" data={series.map((s) => ({ label: `${new Date(s.hour).getHours()}h`, value: s.blocked }))} />
                : <Empty icon="🚨" title="Nothing blocked" text="Blocked payments per hour show here." />}
            </div>
          </div>
        </Step>

        <Step n="2" title="Landing · Unity Catalog volume" state={!db.configured ? 'missing' : lake.pending ? 'warn' : 'ok'}
          sub={<>Settled transactions are exported as NDJSON into <span className="mono">{lake.volume}</span>{p.kafka?.enabled ? ' (Kafka bridge also active)' : ' (Kafka is off, so this export is the ingestion path)'}.</>}
          actions={<button className="btn sm" disabled={!!busy || !lake.pending} onClick={land}>{busy === 'land' ? 'Landing…' : `Land ${lake.pending || 0} new`}</button>}>
          <div className="row" style={{ gap: 24, flexWrap: 'wrap', marginBottom: 10 }}>
            <div><div className="big-num">{int(lake.landed)}</div><div className="faint">rows landed</div></div>
            <div><div className="big-num" style={{ color: lake.pending ? 'var(--warn)' : undefined }}>{int(lake.pending)}</div><div className="faint">waiting</div></div>
            <div><div className="big-num">{lake.lastBatch ? timeAgo(lake.lastBatch.createdAt) : '—'}</div><div className="faint">last landing</div></div>
          </div>
          {lake.recent?.length > 0 && (
            <table className="data">
              <thead><tr><th>File</th><th>Rows</th><th>Size</th><th>When</th></tr></thead>
              <tbody>{lake.recent.map((b) => (
                <tr key={b._id}><td className="mono" title={b.path}>{b.error ? <span style={{ color: 'var(--danger)' }}>failed: {b.error}</span> : b.path.split('/').slice(-2).join('/')}</td><td>{b.rows}</td><td className="faint">{b.bytes ? `${(b.bytes / 1024).toFixed(1)} KB` : '—'}</td><td className="faint">{timeAgo(b.createdAt)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Step>

        <Step n="3" title="Medallion job · Bronze → Silver → Gold" state={!job ? 'missing' : running ? 'running' : taskTone(latest && { result: latest.resultState, state: latest.state })}
          sub={job ? <>Databricks job <b>{job.name}</b> on serverless compute. Latest run {latest ? `${latest.state}${latest.resultState ? ` · ${latest.resultState}` : ''} · ${timeAgo(latest.startTime)}` : 'never'}.</> : 'Not deployed yet — set it up on the Databricks page.'}
          actions={job ? <>
            <ExtLink href={host && `${host}/jobs/${job.jobId}`}>Job in Databricks</ExtLink>
            <button className="btn sm" disabled={!!busy || running} onClick={() => setConfirmRun(true)}>{running ? 'Running…' : 'Run pipeline'}</button>
          </> : <button className="btn sm" onClick={() => go('databricks')}>Set up Databricks</button>}>
          {latest?.tasks?.length ? (
            <div className="task-chain">
              {latest.tasks.map((tk, i) => (
                <React.Fragment key={tk.key}>
                  {i > 0 && <div className={`task-link ${taskTone(latest.tasks[i - 1])}`} />}
                  <a className={`task ${taskTone(tk)}`} href={host ? `${host}/jobs/${job.jobId}/runs/${tk.taskRunId}` : undefined} target="_blank" rel="noopener noreferrer">
                    <div className="task-name">{{ bronze: '🥉 Bronze', silver: '🥈 Silver', gold: '🥇 Gold' }[tk.key] || tk.key}</div>
                    <div className="task-state">{tk.result || tk.state}</div>
                    <div className="faint" style={{ fontSize: 11.5 }}>{tk.startedAt ? duration(tk.startedAt, tk.finishedAt) : 'waiting'}</div>
                    {tk.message && tk.state !== 'TERMINATED' && <div className="faint" style={{ fontSize: 11 }}>{tk.message}</div>}
                  </a>
                </React.Fragment>
              ))}
            </div>
          ) : <Empty icon="🧱" title="No runs yet" text="Land some transactions, then run the pipeline." />}
          {job?.recentRuns?.length > 1 && (
            <>
              <div className="section-label">Recent runs</div>
              <div className="run-pills">
                {job.recentRuns.map((r) => (
                  <a key={r.runId} className={`run-pill ${r.result === 'SUCCESS' ? 'ok' : r.result ? 'error' : 'running'}`} href={host ? `${host}/jobs/${job.jobId}/runs/${r.runId}` : undefined} target="_blank" rel="noopener noreferrer">
                    {r.result || r.state} · {timeAgo(r.startTime)}{r.durationS != null ? ` · ${r.durationS}s` : ''}
                  </a>
                ))}
              </div>
            </>
          )}
        </Step>

        <Step n="4" title="Lakehouse tables" state={mc.gold_fraud_predictions != null ? 'ok' : mc.bronze_events != null ? 'warn' : 'missing'}
          sub={<>Row counts from Unity Catalog <span className="mono">{db.catalog}</span> via the SQL warehouse (cached 5 min, refreshed when a job finishes).</>}>
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
        </Step>
      </div>

      {confirmRun && (
        <Confirm title="Run the medallion pipeline?" confirmLabel="Run on Databricks" busy={busy === 'run'} onCancel={() => setConfirmRun(false)} onConfirm={runPipeline}>
          Starts <b>{job?.name}</b> on Databricks serverless compute (uses workspace compute; about 2–3 minutes). Bronze picks up every file landed since the last run.
        </Confirm>
      )}
    </>
  );
}
