import React, { useState } from 'react';
import { api } from '../api.js';
import { useAdminData, useAction, PageHead, Empty, Confirm, ExtLink, int, timeAgo } from '../ui.jsx';
import { Reconciliation, RunTimeline } from '../flow.jsx';
import '../pipeline.css';

export const taskTone = (t) => (!t ? 'idle' : t.result === 'SUCCESS' ? 'ok' : t.result ? 'error' : ['RUNNING', 'PENDING', 'QUEUED'].includes(t.state) ? 'running' : 'idle');

const TABLES = [
  ['bronze', 'bronze_events', 'Raw events exactly as landed (append-only)'],
  ['silver', 'silver_events', 'Typed, validated, de-duplicated'],
  ['silver', 'silver_quarantine', 'Rows that failed the data contract'],
  ['gold', 'gold_fraud_predictions', 'Every fraud decision + transaction facts'],
  ['gold', 'gold_fraud_kpis', 'Hourly fraud KPIs'],
  ['gold', 'gold_user_behavior', 'Per-user behaviour features'],
  ['ml', 'ml_dataset', 'Latest training dataset snapshot'],
  ['ml', 'ml_features', 'Latest engineered features + split']
];
const LAYER = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', ml: 'ML' };
const STAGE = {
  source: { ico: '🗄️', unit: 'transactions', where: 'MongoDB (operational)' },
  landing: { ico: '📦', unit: 'rows landed', where: 'UC volume · NDJSON files' },
  bronze: { ico: '🥉', unit: 'raw events', where: 'Delta · append-only' },
  silver: { ico: '🥈', unit: 'clean events', where: 'Delta · typed + validated' },
  gold: { ico: '🥇', unit: 'predictions', where: 'Delta · analytics-ready' }
};
const PIPES = [
  ['source', 'landing', 'NDJSON export'],
  ['landing', 'bronze', 'Auto Loader'],
  ['bronze', 'silver', 'clean + validate'],
  ['silver', 'gold', 'aggregate']
];
const ACTIVE = ['PENDING', 'QUEUED', 'RUNNING'];
const fmtS = (s) => (s == null ? '—' : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
const secs = (a, b) => (a && b ? Math.max(0, (new Date(b) - new Date(a)) / 1000) : null);

/** MongoDB → landing → Bronze → Silver → Gold, with coverage and live backlogs. */
function StageRail({ flow }) {
  const s = Object.fromEntries(flow.stages.map((x) => [x.id, x]));
  const latest = flow.runs?.[0];
  const running = latest && ACTIVE.includes(latest.state);
  const task = (k) => latest?.tasks?.find((t) => t.key === k);
  const busy = (k) => running && ['RUNNING', 'PENDING'].includes(task(k)?.state);
  const total = s.source?.rows || 0;
  const backlog = { landing: s.landing?.waitingIn || 0, bronze: s.bronze?.waitingIn || 0 };

  const node = (id) => {
    const st = s[id] || {};
    const m = STAGE[id];
    const cover = id !== 'source' && total && st.rows != null ? Math.min(100, (st.rows / total) * 100) : null;
    const stale = id === 'landing' ? backlog.landing > 0 : ['bronze', 'silver', 'gold'].includes(id) && flow.goldBehind > 0;
    const tone = busy(id) ? 'run' : st.rows == null ? 'idle' : stale ? 'warn' : 'ok';
    return (
      <div className={`pl-node ${id} ${tone}`}>
        <div className="pl-node-ico">{m.ico}</div>
        <div className="pl-node-name">{st.label}</div>
        <div className="pl-node-where">{m.where}</div>
        <div className="pl-node-rows">{st.rows == null ? '—' : int(st.rows)}</div>
        <div className="pl-node-unit">{m.unit}</div>
        {cover != null && (
          <div className="pl-cover" title={`${int(st.rows)} of ${int(total)} MongoDB transactions`}>
            <div><i style={{ width: `${cover}%` }} /></div>
            <span>{Math.round(cover)}% of payments</span>
          </div>
        )}
        <div className={`pl-fresh ${tone}`}>
          {busy(id) ? `${id} task running…` : st.freshAt ? `${id === 'source' ? 'newest' : id === 'landing' ? 'last file' : 'built'} ${timeAgo(st.freshAt)}` : 'never built'}
        </div>
        {id === 'source' && (st.notExported?.stuck || st.notExported?.awaitingCustomer) ? (
          <div className="pl-node-note">held back: {st.notExported.awaitingCustomer} awaiting customer{st.notExported.stuck ? <> · <b>{st.notExported.stuck} stuck</b></> : ''}</div>
        ) : null}
        {id === 'silver' && <div className="pl-node-note">{st.quarantined ? <b>{int(st.quarantined)} quarantined</b> : '0 quarantined'}</div>}
      </div>
    );
  };

  const pipe = ([from, to, label]) => {
    const waiting = to === 'landing' ? backlog.landing : to === 'bronze' ? backlog.bronze : 0;
    const run = busy(to);
    const tone = run ? 'run' : waiting ? 'wait' : 'ok';
    return (
      <div key={`${from}-${to}`} className={`pl-pipe ${tone}`}>
        <div className="pl-pipe-label">{label}</div>
        <div className="pl-pipe-tube">
          {tone !== 'ok' && Array.from({ length: 5 }).map((_, i) => <i key={i} style={{ animationDelay: `${i * 0.35}s` }} />)}
        </div>
        <div className="pl-pipe-state">{run ? 'processing…' : waiting ? <><b>{int(waiting)}</b> waiting</> : '✓ in sync'}</div>
      </div>
    );
  };

  return (
    <div className="pl-rail">
      {node('source')}
      {PIPES.map((p) => <React.Fragment key={p[1]}>{pipe(p)}{node(p[1])}</React.Fragment>)}
    </div>
  );
}

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
  const running = ACTIVE.includes(latest?.state);
  const waiting = latest?.tasks?.find((t) => t.message && t.state !== 'TERMINATED');
  const stages = Object.fromEntries((flow?.stages ?? []).map((x) => [x.id, x]));
  const inBronzeQueue = stages.bronze?.waitingIn || 0;
  const goldBehind = flow?.goldBehind ?? null;

  // run statistics from the real runs the Jobs API returned
  const runs = flow?.runs ?? [];
  const finished = runs.filter((r) => r.result);
  const okRuns = finished.filter((r) => r.result === 'SUCCESS').length;
  const avgTask = (k) => {
    const v = runs.map((r) => r.tasks?.find((t) => t.key === k)).map((t) => secs(t?.startedAt, t?.finishedAt)).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const avgTotal = (() => { const v = finished.map((r) => secs(r.startTime, r.endTime)).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; })();
  const maxLog = Math.log10(Math.max(...Object.values(mc).map((v) => Number(v) || 0), 10));
  const maxFile = Math.max(...(lake.recent ?? []).map((b) => b.rows || 0), 1);

  const land = () => run('land', () => api('/admin/lakehouse/land', { method: 'POST' }), (r) => r.rows ? `Landed ${r.rows} transaction(s) → ${r.path.split('/').slice(-2).join('/')}` : r.message).then(reload);
  const runPipeline = () => run('run', () => api('/admin/databricks/pipeline/run', { method: 'POST', body: { confirm: true } }), 'Pipeline started on Databricks.').then(() => { setConfirmRun(false); reload(); });

  const tone = running ? 'run' : latest?.resultState && latest.resultState !== 'SUCCESS' ? 'bad' : lake.pending || inBronzeQueue ? 'warn' : 'ok';
  const headline = running ? 'Pipeline is running on Databricks'
    : latest?.resultState && latest.resultState !== 'SUCCESS' ? `Last run ${latest.resultState.toLowerCase()}`
      : goldBehind ? `Gold is behind by ${int(goldBehind)} payment${goldBehind === 1 ? '' : 's'}` : 'Lakehouse is up to date';
  const steps = [
    { key: 'land', n: 1, title: 'Land new payments', done: !lake.pending, text: lake.pending ? `${int(lake.pending)} settled payment${lake.pending === 1 ? '' : 's'} not in the volume yet` : 'Nothing waiting in MongoDB' },
    { key: 'run', n: 2, title: 'Run the pipeline', done: !inBronzeQueue && !running, text: running ? 'Running now…' : inBronzeQueue ? `${int(inBronzeQueue)} landed row${inBronzeQueue === 1 ? '' : 's'} not in Bronze yet` : latest ? `Last run ${timeAgo(latest.startTime)}` : 'Never run' },
    { key: 'gold', n: 3, title: 'Gold up to date', done: goldBehind === 0, text: goldBehind ? `${int(goldBehind)} payment${goldBehind === 1 ? '' : 's'} not in Gold yet` : 'Every settled payment is in Gold' }
  ];
  const nextStep = steps.find((s) => !s.done)?.key;

  return (
    <div className="pl">
      <PageHead title="Data pipeline" sub="MongoDB → landing volume → Bronze → Silver → Gold. Counts, backlogs and timings are read live from MongoDB, the Databricks Jobs API and Unity Catalog." />

      {/* ---- hero: state + next step ---- */}
      <section className={`pl-hero ${tone}`}>
        <div className="pl-hero-main">
          <div className="pl-kicker"><span className="pl-pulse" />Medallion pipeline · refreshed every 8 s</div>
          <div className="pl-hero-h">{headline}</div>
          <div className="pl-hero-stats">
            <div><b>{latest ? timeAgo(latest.startTime) : '—'}</b><span>last run</span></div>
            <div><b>{fmtS(avgTotal)}</b><span>avg run ({finished.length})</span></div>
            <div><b>{finished.length ? `${okRuns}/${finished.length}` : '—'}</b><span>runs succeeded</span></div>
            <div><b>{int(lake.landed)}</b><span>rows landed</span></div>
          </div>
          {waiting && <div className="pl-dbx-msg">Databricks says: {waiting.message}</div>}
        </div>
        <div className="pl-next">
          <div className="pl-next-h">What to do next</div>
          {steps.map((s) => (
            <div key={s.key} className={`pl-step ${s.done ? 'done' : ''} ${nextStep === s.key ? 'next' : ''}`}>
              <span className="pl-step-n">{s.done ? '✓' : s.n}</span>
              <div className="pl-step-t"><b>{s.title}</b><span>{s.text}</span></div>
              {s.key === 'land' && !s.done && <button className="btn sm" disabled={!!busy} onClick={land}>{busy === 'land' ? 'Landing…' : `📦 Land ${int(lake.pending)}`}</button>}
              {s.key === 'run' && (job
                ? <button className={`btn sm ${nextStep === 'run' ? '' : 'ghost'}`} disabled={!!busy || running} onClick={() => setConfirmRun(true)}>{running ? 'Running…' : '▶ Run'}</button>
                : <button className="btn sm" onClick={() => go('databricks')}>Set up</button>)}
            </div>
          ))}
        </div>
      </section>

      {/* ---- rail ---- */}
      <section className="card pl-card">
        <div className="card-title">
          <h3><span className="ico">🌊</span> Where the data is now</h3>
          <span className="faint pl-small">moving dots = rows waiting for the next step</span>
        </div>
        {flow ? <StageRail flow={flow} /> : <p className="faint">Loading data flow…</p>}
      </section>

      <section className="card pl-card">
        <div className="card-title"><h3><span className="ico">🔀</span> Where the rows went · last successful run</h3></div>
        {flow ? <Reconciliation rec={flow.reconciliation} /> : <p className="faint">Loading…</p>}
        <div className="card-hint">Numbers are the notebooks’ own exit values (bronze / silver / gold task outputs), checked against each other.</div>
      </section>

      <div className="pl-grid">
        <section className="card pl-card">
          <div className="card-title">
            <h3><span className="ico">⏱️</span> Run timeline</h3>
            <ExtLink href={host && job && `${host}/jobs/${job.jobId}`}>Job in Databricks</ExtLink>
          </div>
          {flow?.runs ? <RunTimeline runs={flow.runs} order={['bronze', 'silver', 'gold']} host={host} jobId={job?.jobId} />
            : job ? <p className="faint">Loading…</p> : <Empty icon="🧱" title="Job not deployed" text="Set it up on the Databricks page." />}
          <div className="card-hint">Grey is time spent waiting for serverless compute before the first task starts.</div>
        </section>
        <section className="card pl-card">
          <div className="card-title"><h3><span className="ico">⚡</span> Stage speed</h3><span className="faint pl-small">average of the last {runs.length || 0} runs</span></div>
          {runs.length ? (
            <div className="pl-speed">
              {['bronze', 'silver', 'gold'].map((k) => {
                const a = avgTask(k);
                const max = Math.max(avgTask('bronze') || 0, avgTask('silver') || 0, avgTask('gold') || 0, 1);
                const last = runs[0]?.tasks?.find((t) => t.key === k);
                return (
                  <div key={k} className={`pl-speed-row ${k}`}>
                    <span className="pl-speed-ico">{STAGE[k].ico}</span>
                    <div className="pl-speed-main">
                      <div className="pl-speed-top"><b>{LAYER[k]}</b><span>{fmtS(a)} avg · last {fmtS(secs(last?.startedAt, last?.finishedAt))}</span></div>
                      <div className="pl-speed-bar"><i style={{ width: `${((a || 0) / max) * 100}%` }} /></div>
                    </div>
                  </div>
                );
              })}
              <div className="pl-speed-total"><span>Whole run, start to finish</span><b>{fmtS(avgTotal)}</b></div>
              <div className="card-hint">Bronze runs first, so its time probably also includes serverless warm-up and Auto Loader listing the landing files.</div>
            </div>
          ) : <Empty icon="⏱️" title="No runs yet" text="Run the pipeline to see stage timings." />}
        </section>
      </div>

      <div className="pl-grid">
        <section className="card pl-card">
          <div className="card-title"><h3><span className="ico">📦</span> Landing files</h3><span className="mono faint pl-small">{lake.volume}</span></div>
          {lake.recent?.length ? (
            <div className="pl-files">
              {lake.recent.map((b) => (
                <div key={b._id} className={`pl-file ${b.error ? 'bad' : ''}`} title={b.path}>
                  <span className="pl-file-ico">{b.error ? '⛔' : '📄'}</span>
                  <div className="pl-file-main">
                    <b>{b.error ? `failed: ${b.error}` : b.path.split('/').pop()}</b>
                    <span>{b.path?.split('/').slice(-2, -1)[0]} · {b.trigger?.toLowerCase() || 'export'} · {timeAgo(b.createdAt)}</span>
                    <div className="pl-file-bar"><i style={{ width: `${((b.rows || 0) / maxFile) * 100}%` }} /></div>
                  </div>
                  <div className="pl-file-n"><b>{int(b.rows)}</b><span>{b.bytes ? `${(b.bytes / 1024).toFixed(1)} KB` : '—'}</span></div>
                </div>
              ))}
            </div>
          ) : <Empty icon="📦" title="Nothing landed yet" text="Press “Land” to export settled transactions." />}
          <div className="card-hint">{p.kafka?.enabled ? 'The Kafka bridge also writes into this volume.' : 'Kafka is off, so this export is the ingestion path.'}</div>
        </section>
        <section className="card pl-card">
          <div className="card-title"><h3><span className="ico">🗃️</span> Lakehouse tables</h3><span className="mono faint pl-small">{db.catalog}</span></div>
          <div className="pl-tables">
            {TABLES.map(([layer, tbl, what]) => {
              const n = mc[tbl];
              const w = n > 0 ? Math.max(3, (Math.log10(n + 1) / maxLog) * 100) : 0;
              const name = host
                ? <a className="mono" href={`${host}/explore/data/${(db.catalog || 'fraud.analytics').replace('.', '/')}/${tbl}`} target="_blank" rel="noopener noreferrer">{tbl}</a>
                : <span className="mono">{tbl}</span>;
              return (
                <div key={tbl} className={`pl-tbl ${layer}`}>
                  <span className="pl-layer">{LAYER[layer]}</span>
                  <div className="pl-tbl-main">{name}<span>{what}</span></div>
                  <span className="pl-tbl-bar"><i style={{ width: `${w}%` }} /></span>
                  <b className="pl-tbl-n">{n == null ? <span className="faint">not created</span> : int(n)}</b>
                </div>
              );
            })}
          </div>
          <div className="card-hint">Row counts via the SQL warehouse, cached 5 min and refreshed when a job finishes. Bars use a log scale.</div>
        </section>
      </div>

      {confirmRun && (
        <Confirm title="Run the medallion pipeline?" confirmLabel="Run on Databricks" busy={busy === 'run'} onCancel={() => setConfirmRun(false)} onConfirm={runPipeline}>
          Starts <b>{job?.name}</b> on Databricks serverless compute (uses workspace compute; about 2–3 minutes). Bronze picks up every file landed since the last run.
        </Confirm>
      )}
    </div>
  );
}
