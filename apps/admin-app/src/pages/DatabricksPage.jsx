import React, { useState } from 'react';
import { api } from '../api.js';
import { useAdminData, useAction, Confirm, StateDot, ExtLink, Empty, timeAgo } from '../ui.jsx';
import { LakehouseArt } from '../illustrations.jsx';

/**
 * Databricks control center: what exists in the workspace, one button to
 * create/update it, and the jobs with their recent runs. All calls go through
 * the API server — the token never reaches the browser.
 */
export default function DatabricksPage({ flash, go }) {
  const { data, reload } = useAdminData({ status: '/admin/databricks/status', pipeline: '/admin/pipeline' }, 15000);
  const [busy, run] = useAction(flash);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState(null);
  const st = data.status;
  const jobs = data.pipeline?.databricks?.jobs ?? [];
  const host = st?.host;

  const provision = () => run('prov', () => api('/admin/databricks/provision', { method: 'POST', body: { confirm: true } }))
    .then((r) => { setConfirm(false); if (r) { setResult(r); flash(r.ok ? 'ok' : 'warn', r.ok ? 'Workspace is set up and in sync.' : 'Some steps failed — see the results below.'); reload(); } });

  const readyCount = st?.checks?.filter((c) => c.state === 'ok').length ?? 0;

  return (
    <>
      <section className="hero-panel slim">
        <div className="hero-copy">
          <div className="eyebrow">Platform</div>
          <h1>Databricks workspace</h1>
          <p>
            {st?.configured
              ? <>Connected to <a href={host} target="_blank" rel="noopener noreferrer">{host?.replace(/^https?:\/\//, '')}</a> as <b>{st.user || '…'}</b>. The API server holds the token; this page only sends commands through it.</>
              : 'Not configured. Set DATABRICKS_HOST and DATABRICKS_TOKEN in .env and restart the API.'}
          </p>
          <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn sm" disabled={!st?.configured || !!busy} onClick={() => setConfirm(true)}>{busy === 'prov' ? 'Syncing…' : st?.ready ? '↻ Sync notebooks & jobs' : '⚡ Set up workspace'}</button>
            <button className="btn ghost sm" onClick={() => go('pipeline')}>Data pipeline</button>
            <button className="btn ghost sm" onClick={() => go('training')}>Model training</button>
          </div>
        </div>
        <LakehouseArt className="hero-art" />
      </section>

      <div className="grid sidebar">
        <div className="card">
          <div className="card-title">
            <h3><span className="ico">✅</span> Workspace resources</h3>
            {st?.checks && <span className={`badge ${st.ready ? 'LOW' : 'MEDIUM'}`}>{readyCount}/{st.checks.length} ready</span>}
          </div>
          {!st ? <p className="faint">Checking workspace…</p> : !st.configured ? <Empty icon="🔌" title="Not connected" text="Add DATABRICKS_HOST and DATABRICKS_TOKEN to the root .env." /> : (
            <div className="checklist">
              {st.checks.map((c) => (
                <div key={c.key} className={`check ${c.state}`}>
                  <StateDot state={c.state === 'ok' ? 'ok' : c.state === 'missing' ? 'warn' : 'error'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="check-label">{c.label}</div>
                    <div className="faint check-detail">{c.detail}</div>
                  </div>
                  {c.url && <ExtLink href={c.url}>Open</ExtLink>}
                </div>
              ))}
            </div>
          )}
          {result && (
            <>
              <div className="section-label">Last sync</div>
              {result.steps.map((s, i) => (
                <div key={i} className="sync-step"><span>{s.ok ? '✅' : '⛔'}</span><b>{s.step}</b><span className="faint">{s.detail}</span></div>
              ))}
            </>
          )}
        </div>

        <div className="card">
          <div className="card-title"><h3><span className="ico">🧭</span> What “set up” does</h3></div>
          <ol className="howto">
            <li>Creates catalog <span className="mono">fraud</span>, schemas <span className="mono">analytics</span> + <span className="mono">landing</span> and the landing volume (Unity Catalog, SQL fallback for Free Edition).</li>
            <li>Uploads the 7 notebooks from <span className="mono">databricks/notebooks</span> to your workspace folder.</li>
            <li>Creates or updates two serverless jobs: the medallion pipeline and model training.</li>
            <li>Safe to repeat: every step is idempotent, so re-sync after editing a notebook.</li>
          </ol>
          <div className="card-hint">No compute is used by set-up. Compute runs only when you start the pipeline or a training run.</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-title"><h3><span className="ico">🧱</span> Jobs</h3></div>
        {jobs.length === 0 ? <Empty icon="🧱" title="No SentinelPay jobs" text="Run set-up to create them." /> : (
          <div className="grid cols-2">
            {jobs.map((j) => (
              <div key={j.jobId} className="job-card">
                <div className="row between"><b>{j.name}</b><ExtLink href={host && `${host}/jobs/${j.jobId}`}>Job</ExtLink></div>
                <div className="faint" style={{ fontSize: 12.5, margin: '2px 0 10px' }}>job id {j.jobId} · {j.latestRun?.tasks?.length || '—'} tasks</div>
                {j.recentRuns?.length ? j.recentRuns.map((r) => (
                  <a key={r.runId} className="job-run" href={host ? `${host}/jobs/${j.jobId}/runs/${r.runId}` : undefined} target="_blank" rel="noopener noreferrer">
                    <StateDot state={r.result === 'SUCCESS' ? 'ok' : r.result ? 'error' : 'running'} />
                    <span>{r.result || r.state}</span>
                    <span className="faint">{timeAgo(r.startTime)}{r.durationS != null ? ` · ${r.durationS}s` : ''}</span>
                  </a>
                )) : <div className="faint">No runs yet.</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {confirm && (
        <Confirm title={st?.ready ? 'Sync notebooks and jobs?' : 'Set up the Databricks workspace?'} confirmLabel={st?.ready ? 'Sync' : 'Set up'} busy={busy === 'prov'} onCancel={() => setConfirm(false)} onConfirm={provision}>
          This creates or updates Unity Catalog objects, notebooks and jobs in <b>{host}</b>. It does not start any compute.
        </Confirm>
      )}
    </>
  );
}
