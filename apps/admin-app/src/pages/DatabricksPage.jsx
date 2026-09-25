import React, { useState } from 'react';
import { api } from '../api.js';
import { useAdminData, useAction, PageHead, Confirm, ExtLink, Empty, timeAgo, int } from '../ui.jsx';
import '../databricks.css';

/**
 * Databricks control center: what exists in the workspace, one button to
 * create/update it, the jobs with their real task timings and runs, the
 * Unity Catalog tables with their row counts, and the model registry.
 * All calls go through the API server — the token never reaches the browser.
 */

const ACTIVE = ['PENDING', 'QUEUED', 'RUNNING', 'BLOCKED'];
const TASK_ICO = { bronze: '🥉', silver: '🥈', gold: '🥇', load_dataset: '📥', build_features: '🧩', train_model: '🧠', evaluate_register: '🏷️' };
const JOB_META = {
  'sentinelpay-medallion-pipeline': { ico: '🌊', title: 'Medallion pipeline', what: 'Landing volume → Bronze → Silver → Gold', go: 'pipeline' },
  'sentinelpay-model-training': { ico: '🧠', title: 'Model training', what: 'Dataset → features → train → evaluate & register', go: 'training' }
};
const TABLES = [
  { key: 'bronze_events', layer: 'bronze', what: 'raw events, as landed' },
  { key: 'silver_events', layer: 'silver', what: 'cleaned + typed' },
  { key: 'silver_quarantine', layer: 'silver', what: 'rows that failed checks' },
  { key: 'gold_fraud_predictions', layer: 'gold', what: 'one row per scored payment' },
  { key: 'gold_fraud_kpis', layer: 'gold', what: 'daily fraud KPIs' },
  { key: 'gold_user_behavior', layer: 'gold', what: 'per-user behaviour profile' },
  { key: 'ml_dataset', layer: 'ml', what: 'training dataset' },
  { key: 'ml_features', layer: 'ml', what: 'model-ready features' }
];
const LAYER = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', ml: 'ML' };

const secs = (a, b) => Math.max(0, Math.round((new Date(b || Date.now()) - new Date(a)) / 1000));
const dur = (s) => (s == null ? '—' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
const runTone = (r) => (r.result === 'SUCCESS' ? 'ok' : r.result ? 'bad' : ACTIVE.includes(r.state) ? 'run' : 'idle');
const checkTone = (c) => (c.state === 'ok' ? 'ok' : c.state === 'missing' ? 'warn' : 'bad');
const CHECK_ICO = { connection: '🔌', warehouse: '🧮', catalog: '📚', schema: '🗂️', volume: '📦', notebooks: '📓' };

function Ring({ value, total, tone }) {
  const c = 2 * Math.PI * 40;
  const f = total ? value / total : 0;
  return (
    <div className={`dx-ring ${tone}`}>
      <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" className="bg" /><circle cx="50" cy="50" r="40" className="fg" strokeDasharray={`${c * f} ${c}`} /></svg>
      <div className="dx-ring-c"><b>{total ? `${value}/${total}` : '—'}</b><span>ready</span></div>
    </div>
  );
}

/** Real task timings of a job's latest run, drawn as a timeline. */
function TaskTimeline({ run }) {
  const tasks = run?.tasks ?? [];
  if (!tasks.length) return <div className="faint dx-small">No task timings yet.</div>;
  const t0 = Math.min(...tasks.filter((t) => t.startedAt).map((t) => +new Date(t.startedAt)), +new Date(run.startTime));
  const t1 = Math.max(...tasks.map((t) => +new Date(t.finishedAt || (t.startedAt ? Date.now() : 0))), t0 + 1000);
  const span = t1 - t0;
  return (
    <div className="dx-tl">
      {tasks.map((t) => {
        const tone = t.result === 'SUCCESS' ? 'ok' : t.result ? 'bad' : t.startedAt ? 'run' : 'idle';
        const left = t.startedAt ? ((+new Date(t.startedAt) - t0) / span) * 100 : 0;
        const width = t.startedAt ? Math.max(2, ((+new Date(t.finishedAt || Date.now()) - +new Date(t.startedAt)) / span) * 100) : 0;
        return (
          <div key={t.key} className="dx-tl-row" title={t.message || `${t.key}: ${t.result || t.state}`}>
            <span className="dx-tl-name">{TASK_ICO[t.key] || '▫️'} {t.key}</span>
            <div className="dx-tl-track">
              {t.startedAt ? <i className={tone} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} /> : <em>waiting</em>}
            </div>
            <span className="dx-tl-dur">{t.startedAt ? dur(secs(t.startedAt, t.finishedAt)) : '—'}</span>
          </div>
        );
      })}
      <div className="dx-tl-axis"><span>{new Date(t0).toLocaleTimeString()}</span><span>{dur(Math.round(span / 1000))} total</span></div>
    </div>
  );
}

function JobCard({ job, host, go }) {
  const meta = JOB_META[job.name] || { ico: '🧱', title: job.name, what: '' };
  const runs = job.recentRuns ?? [];
  const latest = job.latestRun;
  const live = latest && ACTIVE.includes(latest.state);
  const done = runs.filter((r) => r.result);
  const ok = done.filter((r) => r.result === 'SUCCESS').length;
  const maxD = Math.max(...runs.map((r) => r.durationS || 0), 1);
  const tone = live ? 'run' : latest?.resultState === 'SUCCESS' ? 'ok' : latest?.resultState ? 'bad' : 'idle';
  return (
    <div className={`dx-job ${tone}`}>
      <div className="dx-job-top">
        <span className="dx-job-ico">{meta.ico}</span>
        <div className="dx-job-name"><b>{meta.title}</b><span>{meta.what}</span></div>
        <span className={`dx-pill ${tone}`}><i />{live ? latest.state.toLowerCase() : latest?.resultState?.toLowerCase() || 'no runs'}</span>
      </div>
      {live && <div className="dx-live">Running now, started {timeAgo(latest.startTime)}. This page refreshes every 15 s.</div>}
      <div className="dx-sec">Latest run · tasks <span className="faint">{latest ? `started ${timeAgo(latest.startTime)}` : ''}</span></div>
      <TaskTimeline run={latest} />
      <div className="dx-sec">Recent runs <span className="faint">{done.length ? `${ok}/${done.length} succeeded` : ''}</span></div>
      {runs.length ? (
        <div className="dx-runs">
          {runs.map((r) => (
            <a key={r.runId} className={`dx-run ${runTone(r)}`} href={host ? `${host}/jobs/${job.jobId}/runs/${r.runId}` : undefined} target="_blank" rel="noopener noreferrer" title={`Run ${r.runId} · ${r.state}`}>
              <span className="dx-run-dot" />
              <span className="dx-run-res">{r.result || r.state}</span>
              <span className="dx-run-bar"><i style={{ width: `${((r.durationS || 0) / maxD) * 100}%` }} /></span>
              <span className="dx-run-meta">{dur(r.durationS)} · {timeAgo(r.startTime)} ↗</span>
            </a>
          ))}
        </div>
      ) : <div className="faint dx-small">No runs yet.</div>}
      <div className="dx-job-foot">
        <span className="faint">job id {job.jobId}</span>
        <span className="row" style={{ gap: 8 }}>
          {meta.go && <button className="dx-link" onClick={() => go?.(meta.go)}>{meta.go === 'pipeline' ? 'Run it from Data pipeline' : 'Train from Model training'} →</button>}
          <ExtLink href={host && `${host}/jobs/${job.jobId}`}>Job</ExtLink>
        </span>
      </div>
    </div>
  );
}

export default function DatabricksPage({ flash, go }) {
  const { data, reload } = useAdminData({ status: '/admin/databricks/status', pipeline: '/admin/pipeline' }, 15000);
  const { data: ml } = useAdminData({ mlflow: '/admin/training/mlflow' }, 60000);
  const [busy, run] = useAction(flash);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState(null);
  const [hoverTable, setHoverTable] = useState(null);
  const st = data.status;
  const dbx = data.pipeline?.databricks;
  const jobs = dbx?.jobs ?? [];
  const counts = dbx?.medallionCounts;
  const lake = data.pipeline?.lakehouse;
  const mlflow = ml.mlflow;
  const versions = [...(mlflow?.modelVersions ?? [])].sort((a, b) => Number(b.version) - Number(a.version));
  const latestRun = mlflow?.runs?.[0];
  const host = st?.host;

  const provision = () => run('prov', () => api('/admin/databricks/provision', { method: 'POST', body: { confirm: true } }))
    .then((r) => { setConfirm(false); if (r) { setResult(r); flash(r.ok ? 'ok' : 'warn', r.ok ? 'Workspace is set up and in sync.' : 'Some steps failed — see the results below.'); reload(); } });

  const checks = st?.checks ?? [];
  const readyCount = checks.filter((c) => c.state === 'ok').length;
  const heroTone = !st ? 'idle' : !st.configured ? 'bad' : st.ready ? 'ok' : 'warn';
  const allRuns = jobs.flatMap((j) => j.recentRuns ?? []).filter((r) => r.result);
  const okRuns = allRuns.filter((r) => r.result === 'SUCCESS').length;
  const maxLog = Math.log10(Math.max(...Object.values(counts || {}).map((v) => Number(v) || 0), 10));

  return (
    <div className="dx">
      <PageHead title="Databricks workspace" sub="Everything SentinelPay keeps in Databricks, read live through the API server. The token never reaches this browser.">
        <button className="btn sm" disabled={!st?.configured || !!busy} onClick={() => setConfirm(true)}>{busy === 'prov' ? 'Syncing…' : st?.ready ? '↻ Sync notebooks & jobs' : '⚡ Set up workspace'}</button>
      </PageHead>

      {/* ---- hero ---- */}
      <section className={`dx-hero ${heroTone}`}>
        <div className="dx-brand">
          <div className="dx-logo" aria-hidden="true"><span /><span /><span /></div>
          <div className="dx-ws">
            <div className="dx-kicker"><span className="dx-pulse" />{!st ? 'Checking workspace…' : !st.configured ? 'Not connected' : st.ready ? 'Connected · set up' : 'Connected · set-up incomplete'}</div>
            {st?.configured
              ? <><a className="dx-host" href={host} target="_blank" rel="noopener noreferrer">{host?.replace(/^https?:\/\//, '')} ↗</a>
                  <div className="dx-owner">Token owner <b>{st.user || '—'}</b> · catalog <code>{st.catalog}</code></div></>
              : <div className="dx-host">{st ? 'Set DATABRICKS_HOST and DATABRICKS_TOKEN in .env and restart the API.' : '…'}</div>}
          </div>
        </div>
        <Ring value={readyCount} total={checks.length} tone={heroTone} />
        <div className="dx-stats">
          <div><b>{st ? jobs.length : '—'}</b><span>jobs deployed</span></div>
          <div><b>{allRuns.length ? `${okRuns}/${allRuns.length}` : '—'}</b><span>recent runs OK</span></div>
          <div><b>{versions[0] ? `v${versions[0].version}` : '—'}</b><span>latest model</span></div>
          <div><b>{counts ? int(Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0)) : '—'}</b><span>rows in tables</span></div>
        </div>
      </section>

      {/* ---- set-up stepper ---- */}
      <section className="card dx-card">
        <div className="card-title">
          <h3><span className="ico">✅</span> Workspace set-up</h3>
          {checks.length > 0 && <span className="faint dx-small">{readyCount} of {checks.length} resources ready · checked every 15 s</span>}
        </div>
        {!st ? <p className="faint">Checking workspace…</p> : !st.configured ? <Empty icon="🔌" title="Not connected" text="Add DATABRICKS_HOST and DATABRICKS_TOKEN to the root .env." /> : (
          <>
            <div className="dx-steps">
              {checks.map((c, i) => {
                const tone = checkTone(c);
                const ico = CHECK_ICO[c.key] || (c.key.startsWith('job:') ? '⚙️' : '•');
                const inner = (
                  <>
                    <span className="dx-step-n"><span>{ico}</span><em>{tone === 'ok' ? '✓' : tone === 'warn' ? '!' : '✕'}</em></span>
                    <b>{c.label.replace(/^Job /, '')}</b>
                    <span>{c.detail}</span>
                  </>
                );
                return (
                  <React.Fragment key={c.key}>
                    {i > 0 && <span className={`dx-step-link ${tone}`} />}
                    {c.url
                      ? <a className={`dx-step ${tone}`} href={c.url} target="_blank" rel="noopener noreferrer" title={`Open in Databricks: ${c.label}`}>{inner}</a>
                      : <div className={`dx-step ${tone}`}>{inner}</div>}
                  </React.Fragment>
                );
              })}
            </div>
            {!st.ready && <div className="dx-hint">Missing pieces are created by <b>Set up workspace</b>. It is idempotent and starts no compute.</div>}
          </>
        )}
        {result && (
          <div className="dx-sync">
            <div className="dx-sec">Last sync</div>
            {result.steps.map((s, i) => (
              <div key={i} className={`dx-sync-step ${s.ok ? 'ok' : 'bad'}`}><span>{s.ok ? '✓' : '✕'}</span><b>{s.step}</b><em>{s.detail}</em></div>
            ))}
          </div>
        )}
      </section>

      {/* ---- jobs ---- */}
      <div className="dx-sechead"><span className="dx-sechead-ico">⚙️</span><div><h3>Jobs</h3><p>Serverless jobs created by set-up. Timings come from the latest run's tasks.</p></div></div>
      {jobs.length === 0
        ? <div className="card"><Empty icon="🧱" title={dbx ? 'No SentinelPay jobs' : 'Loading jobs…'} text={dbx ? 'Run set-up to create them.' : ''} /></div>
        : <div className="dx-jobs">{jobs.map((j) => <JobCard key={j.jobId} job={j} host={host} go={go} />)}</div>}

      {/* ---- catalog + models ---- */}
      <div className="dx-sechead"><span className="dx-sechead-ico">📚</span><div><h3>Unity Catalog</h3><p>What lives in the catalog, with live row counts from the SQL warehouse.</p></div></div>
      <div className="dx-grid">
        <section className="card dx-card">
          <div className="dx-tree">
            <div className="dx-node root"><span>📚</span><b>{(st?.catalog || 'fraud.analytics').split('.')[0]}</b><em>catalog</em></div>
            <div className="dx-branch">
              <div className="dx-node"><span>🗂️</span><b>landing</b><em>schema</em></div>
              <div className="dx-branch">
                <div className="dx-leaf vol">
                  <span>📦</span>
                  <div><b>events</b><em>volume · {lake?.volume || st?.volume || '—'}</em></div>
                  <span className="dx-leaf-n">{lake ? <>{int(lake.landed)} landed<small>{lake.pending ? ` · ${int(lake.pending)} waiting` : ' · none waiting'}</small></> : '—'}</span>
                </div>
              </div>
              <div className="dx-node"><span>🗂️</span><b>{(st?.catalog || 'fraud.analytics').split('.')[1]}</b><em>schema</em></div>
              <div className="dx-branch">
                {!counts && <div className="faint dx-small">{dbx && !dbx.warehouseConfigured ? 'Row counts need DATABRICKS_WAREHOUSE_ID.' : 'Reading row counts…'}</div>}
                {counts && TABLES.map((t) => {
                  const n = counts[t.key];
                  const w = n > 0 ? Math.max(3, (Math.log10(n + 1) / maxLog) * 100) : 0;
                  return (
                    <div key={t.key} className={`dx-leaf ${t.layer} ${hoverTable === t.layer ? 'hl' : ''}`} onMouseEnter={() => setHoverTable(t.layer)} onMouseLeave={() => setHoverTable(null)}>
                      <span className="dx-layer">{LAYER[t.layer]}</span>
                      <div><b>{t.key}</b><em>{t.what}</em></div>
                      <span className="dx-leaf-bar"><i style={{ width: `${w}%` }} /></span>
                      <span className="dx-leaf-n">{n == null ? '—' : int(n)}</span>
                    </div>
                  );
                })}
                <div className="dx-leaf model">
                  <span>🏷️</span>
                  <div><b>{(mlflow?.registeredModel || 'fraud.analytics.fraud_classifier').split('.').pop()}</b><em>registered model</em></div>
                  <span className="dx-leaf-n">{versions.length ? `${versions.length} versions` : '—'}</span>
                </div>
              </div>
            </div>
          </div>
          {counts && <div className="dx-hint">Bar length uses a log scale, because the ML tables are about 1,000× bigger than the live ones.</div>}
        </section>

        <section className="card dx-card">
          <div className="card-title"><h3><span className="ico">🏷️</span> Model registry</h3>{host && <ExtLink href={`${host}/explore/data/models/${(mlflow?.registeredModel || '').replace(/\./g, '/')}`}>Open</ExtLink>}</div>
          {!mlflow ? <p className="faint">Reading MLflow…</p> : !versions.length ? <Empty icon="🏷️" title="No versions yet" text="Train a model to register the first version." /> : (
            <div className="dx-versions">
              {versions.slice(0, 7).map((v, i) => (
                <div key={v.version} className={`dx-ver ${i === 0 ? 'latest' : ''}`}>
                  <span className="dx-ver-v">v{v.version}</span>
                  <div><b>{i === 0 ? 'Latest version' : `Version ${v.version}`}</b><em>{v.status?.toLowerCase().replace(/_/g, ' ') || '—'} · {v.createdAt ? timeAgo(v.createdAt) : '—'}</em></div>
                  {i === 0 && <span className="dx-ver-tag">newest</span>}
                </div>
              ))}
            </div>
          )}
          {latestRun && (
            <div className="dx-lastrun">
              <div className="dx-sec">Latest MLflow run <span className="faint">{latestRun.runName}</span></div>
              {[['ROC AUC', 'roc_auc'], ['Recall', 'recall'], ['Precision', 'precision']].map(([label, k]) => {
                const v = latestRun.metrics?.[k], b = latestRun.metrics?.[`baseline_${k}`];
                return (
                  <div key={k} className="dx-metric">
                    <span>{label}</span>
                    <div className="dx-metric-bar"><i style={{ width: `${(v || 0) * 100}%` }} />{b != null && <u style={{ left: `${b * 100}%` }} title={`rules baseline ${b.toFixed(3)}`} />}</div>
                    <b>{v != null ? v.toFixed(3) : '—'}</b>
                  </div>
                );
              })}
              <div className="dx-hint">The white tick is the rules baseline scored on the same test set. <button className="dx-link" onClick={() => go?.('training')}>Compare runs →</button></div>
            </div>
          )}
        </section>
      </div>

      {/* ---- how set-up works ---- */}
      <section className="card dx-card dx-how">
        <div className="card-title"><h3><span className="ico">🧭</span> What “set up” does</h3><span className="faint dx-small">Safe to repeat · no compute used</span></div>
        <div className="dx-how-grid">
          {[
            ['📚', 'Unity Catalog', <>Creates catalog <code>fraud</code>, schemas <code>analytics</code> + <code>landing</code> and the landing volume (SQL fallback on Free Edition).</>],
            ['📓', 'Notebooks', <>Uploads the 7 notebooks from <code>databricks/notebooks</code> to your workspace folder.</>],
            ['⚙️', 'Jobs', <>Creates or updates two serverless jobs: the medallion pipeline and model training.</>],
            ['🔁', 'Idempotent', <>Every step checks first, so re-sync after editing a notebook. Compute runs only when you start a job.</>]
          ].map(([ico, h, p], i) => (
            <div key={h} className="dx-how-step"><span className="dx-how-n">{i + 1}</span><span className="dx-how-ico">{ico}</span><b>{h}</b><p>{p}</p></div>
          ))}
        </div>
      </section>

      {confirm && (
        <Confirm title={st?.ready ? 'Sync notebooks and jobs?' : 'Set up the Databricks workspace?'} confirmLabel={st?.ready ? 'Sync' : 'Set up'} busy={busy === 'prov'} onCancel={() => setConfirm(false)} onConfirm={provision}>
          This creates or updates Unity Catalog objects, notebooks and jobs in <b>{host}</b>. It does not start any compute.
        </Confirm>
      )}
    </div>
  );
}
