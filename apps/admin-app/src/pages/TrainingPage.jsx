import React, { Suspense, lazy, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAdminData, useAction, PageHead, Empty, Confirm, CompareBars, Kpi, ExtLink, fmt, pct, int, timeAgo, duration } from '../ui.jsx';
import { TrainingTimeline, Confusion } from '../flow.jsx';
import { buildTrainingGraph } from '../architecture/graph.js';
import { hasWebGL } from '../architecture/ArchitectureTab.jsx';
import Fallback2D from '../architecture/Fallback2D.jsx';

const Scene3D = lazy(() => import('../architecture/Scene3D.jsx'));

const STAGE_INFO = {
  load_dataset: { ico: '📥', title: 'Load dataset', show: (o) => o && [`${int(o.rows)} rows`, `${int(o.fraud_rows)} fraud (${pct(o.fraud_rate)})`, `Delta v${o.delta_version}`] },
  build_features: { ico: '🧮', title: 'Features + quality', show: (o) => o && [`${o.n_features} features`, `train ${int(o.n_train)} / test ${int(o.n_test)}`, `${int(o.dropped_rows)} rows dropped`] },
  train_model: { ico: '🏋️', title: 'Train model', show: (o) => o && [`${o.train_seconds}s fit`, `train F1 ${fmt(o.train_f1)}`, `train AUC ${fmt(o.train_roc_auc)}`] },
  evaluate_register: { ico: '🎯', title: 'Evaluate + register', show: (o) => o?.metrics && [`test F1 ${fmt(o.metrics.f1)}`, `PR-AUC ${fmt(o.metrics.pr_auc)}`, o.registered_version ? `registered v${o.registered_version}` : 'not registered'] }
};
const METRICS = [['precision', 'Precision'], ['recall', 'Recall'], ['f1', 'F1'], ['rocAuc', 'ROC-AUC'], ['prAuc', 'PR-AUC']];
const stageTone = (s) => (!s ? 'idle' : s.result === 'SUCCESS' ? 'ok' : s.result ? 'error' : ['RUNNING', 'PENDING'].includes(s.state) ? 'running' : s.state === 'QUEUED' ? 'warn' : 'idle');

function RunStages({ run, stages, host }) {
  return (
    <div className="stage-cards">
      {stages.map((key, i) => {
        const s = run?.stages?.find((x) => x.key === key);
        const info = STAGE_INFO[key];
        const tone = stageTone(s);
        const lines = info.show(s?.output);
        return (
          <div key={key} className={`stage-card ${tone}`}>
            <div className="row between"><span className="stage-n">{i + 1}</span><span className={`sdot ${tone}`} /></div>
            <div className="stage-title">{info.ico} {info.title}</div>
            <div className="stage-state">{s ? (s.result || s.state) : 'not started'}{s?.startedAt ? ` · ${duration(s.startedAt, s.finishedAt)}` : ''}</div>
            {lines ? <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
              : s?.output?.error ? <div className="stage-err">{String(s.output.error).slice(0, 220)}</div>
              : s?.message ? <div className="faint" style={{ fontSize: 12 }}>{s.message}</div> : null}
            {host && run?.databricksJobId && s?.taskRunId && <a className="stage-link" href={`${host}/jobs/${run.databricksJobId}/runs/${s.taskRunId}`} target="_blank" rel="noopener noreferrer">task run ↗</a>}
          </div>
        );
      })}
    </div>
  );
}

export default function TrainingPage({ flash, go }) {
  const { data, reload } = useAdminData({ training: '/admin/training', mlflow: '/admin/training/mlflow', options: '/admin/training/options', pipeline: '/admin/pipeline', system: '/admin/system' }, 5000);
  const { training, mlflow, options, pipeline, system } = data;
  const [busy, run] = useAction(flash);
  const [model, setModel] = useState('logistic_regression');
  const [dataset, setDataset] = useState('synthetic_payments');
  const [confirm, setConfirm] = useState(false);
  const [stageAsk, setStageAsk] = useState(false);
  const [selected, setSelected] = useState(null);
  const [viewRun, setViewRun] = useState(null);
  const webgl = useMemo(hasWebGL, []);

  const host = pipeline?.databricks?.host;
  const runs = training?.runs ?? [];
  const cur = training?.current;
  const active = cur && ['QUEUED', 'RUNNING'].includes(cur.status);
  const shown = runs.find((r) => r._id === viewRun) || cur;
  const stages = training?.stages ?? ['load_dataset', 'build_features', 'train_model', 'evaluate_register'];
  const job = (pipeline?.databricks?.jobs || []).find((j) => j.name?.includes('model-training'));
  const ds = options?.datasets?.find((d) => d.id === dataset);
  const graph = useMemo(() => buildTrainingGraph({ run: shown, options, mlflow, system, host }), [shown, options, mlflow, system, host]);
  const completed = runs.filter((r) => r.status === 'COMPLETED' && r.metrics?.f1 != null);

  const stage = () => run('stage', () => api('/admin/training/datasets/creditcard_benchmark/stage', { method: 'POST', body: { confirm: true } }),
    'Staging started — the download runs in the background on the API server.').then((r) => { setStageAsk(false); if (r) reload(); });
  const start = () => run('start', () => api('/admin/training/start', { method: 'POST', body: { confirm: true, model, dataset } }), 'Training started on Databricks.')
    .then((r) => { setConfirm(false); setViewRun(null); if (r) reload(); });

  return (
    <>
      <PageHead title="Model training" sub="Pick a model and a dataset, train it on Databricks, and compare it with the base model that scores live payments today. Training only starts when you press the button." />

      <div className="grid train-grid">
        <div className="card">
          <div className="card-title"><h3><span className="ico">⚙️</span> 1 · Choose a model</h3></div>
          {!options && <p className="faint" style={{ fontSize: 13 }}>Loading models and datasets from the API (the first load after a restart counts every lakehouse table, so it can take up to a minute)…</p>}
          <div className="choice-grid">
            {(options?.models || []).map((m) => (
              <button key={m.id} className={`choice ${model === m.id ? 'on' : ''}`} onClick={() => setModel(m.id)} disabled={active}>
                <b>{m.label}</b><span>{m.note}</span>
              </button>
            ))}
          </div>
          <div className="card-title" style={{ marginTop: 18 }}><h3><span className="ico">🗂️</span> 2 · Choose a dataset</h3></div>
          <div className="choice-grid">
            {(options?.datasets || []).map((d) => (
              <button key={d.id} className={`choice ${dataset === d.id ? 'on' : ''} ${d.available ? '' : 'off'}`} onClick={() => setDataset(d.id)} disabled={active}>
                <b>{d.label} {d.rows != null && <em>{int(d.rows)} rows</em>}</b>
                <span>{d.note}</span>
                <span className="row" style={{ gap: 6, marginTop: 4 }}>
                  {d.engineCompatible ? <i className="tag ok">live-compatible features</i> : <i className="tag">benchmark only</i>}
                  {!d.available && <i className="tag warn">not available yet</i>}
                </span>
              </button>
            ))}
          </div>
          {ds?.stageable && ds.staged === false && !ds.cached && (() => {
            const job = ds.stageJob;
            const working = job && ['downloading', 'uploading'].includes(job.state);
            const mb = (b) => (b / 1048576).toFixed(1);
            return (
              <div className={`flash ${job?.state === 'error' ? 'error' : 'info'}`} style={{ marginTop: 12 }}>
                <span>🌐</span>
                <div style={{ flex: 1 }}>
                  {working ? (
                    <>{(() => {
                      const done = job.state === 'uploading' ? job.uploaded || 0 : job.bytes;
                      return (<>
                        <b>{job.state === 'downloading' ? 'Step 1 of 2 · downloading from openml.org…' : 'Step 2 of 2 · uploading into the landing volume…'}</b> {mb(done)}{job.total ? ` / ${mb(job.total)} MB (${Math.round((done / job.total) * 100)}%)` : ' MB'} · started {timeAgo(job.startedAt)}. This can take a while on a slow connection; you can leave this page.
                        {job.total > 0 && <div className="progress" style={{ marginTop: 6 }}><i style={{ width: `${(done / job.total) * 100}%` }} /></div>}
                      </>);
                    })()}</>
                  ) : job?.state === 'error' ? (
                    <><b>Staging failed.</b> {job.error}</>
                  ) : (
                    <><b>Stage the benchmark first.</b> Databricks serverless compute in this workspace cannot reach the internet, so the API server downloads the file (~73 MB from openml.org) and uploads it into <span className="mono">/Volumes/fraud/landing/events/reference</span>.</>
                  )}
                </div>
                {!working && <button className="btn sm" disabled={!!busy} onClick={() => setStageAsk(true)}>{job?.state === 'error' ? 'Try again' : 'Stage into lakehouse'}</button>}
              </div>
            );
          })()}
          <div className="row between" style={{ marginTop: 16, flexWrap: 'wrap', gap: 10 }}>
            <div className="faint" style={{ fontSize: 12.5 }}>
              {!job ? 'Training job not deployed — set up Databricks first.' : active ? `A run is ${cur.status.toLowerCase()}; one run at a time.` : 'Runs 4 tasks on Databricks serverless compute (~5–8 min).'}
            </div>
            {!job ? <button className="btn" onClick={() => go('databricks')}>Set up Databricks</button>
              : <button className="btn" disabled={active || !ds?.available || !!busy} onClick={() => setConfirm(true)}>🚀 Start training</button>}
          </div>
        </div>

        <div className="card train-stage-card">
          <div className="card-title">
            <h3><span className="ico">🧭</span> 3 · Watch it run {shown && <span className="faint" style={{ fontWeight: 500, fontSize: 13 }}>· {shown.modelType?.replaceAll('_', ' ')} on {shown.dataset?.replaceAll('_', ' ')}</span>}</h3>
            {shown && <span className={`badge ${shown.status === 'COMPLETED' ? 'LOW' : shown.status === 'FAILED' ? 'BLOCKED' : 'MEDIUM'}`}>{shown.status}</span>}
          </div>
          <div className="mini-stage">
            {webgl ? (
              <Suspense fallback={<div className="arch-loading">Loading 3D…</div>}>
                <Scene3D nodes={graph.nodes} edges={graph.edges} selected={selected} focus="all" onSelect={setSelected} trainingActive={graph.active} compact />
              </Suspense>
            ) : <Fallback2D nodes={graph.nodes} edges={graph.edges} selected={selected} focus="all" onSelect={setSelected} />}
            {selected && graph.nodes.find((n) => n.id === selected) && (() => {
              const nd = graph.nodes.find((n) => n.id === selected);
              return (
                <div className="mini-panel">
                  <div className="row between"><b>{nd.label}</b><button className="btn ghost sm" onClick={() => setSelected(null)} aria-label="Close">✕</button></div>
                  <div className="faint" style={{ fontSize: 12, margin: '4px 0 8px' }}>{nd.statusLabel}</div>
                  {nd.metrics.map(([k, v]) => <div key={k} className="mini-kv"><span>{k}</span><b>{v}</b></div>)}
                </div>
              );
            })()}
          </div>
          {shown?.stateMessage && shown.status === 'FAILED' && <div className="flash error" style={{ marginTop: 12 }}><span>⛔</span><div>{shown.stateMessage}</div></div>}
        </div>
      </div>

      {shown ? <RunStages run={shown} stages={stages} host={host} /> : (
        <div className="card" style={{ marginTop: 18 }}><Empty icon="🧠" title="No training runs yet" text="Choose a model and a dataset above, then start training. Each stage lights up here as Databricks reports it." /></div>
      )}

      {shown?.startedAt && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-title"><h3><span className="ico">⏱️</span> Where the time went</h3><span className="faint" style={{ fontSize: 12 }}>task start/end times reported by Databricks</span></div>
          <TrainingTimeline run={shown} order={stages} />
        </div>
      )}

      {shown?.metrics?.f1 != null && (
        <div className="grid cols-2" style={{ marginTop: 18 }}>
          <div className="card">
            <div className="card-title"><h3><span className="ico">⚖️</span> New model vs base model</h3><span className="faint" style={{ fontSize: 12 }}>same held-out test set</span></div>
            <CompareBars metrics={METRICS} series={[
              { name: shown.modelType?.replaceAll('_', ' '), color: 'linear-gradient(90deg,#4f7cff,#8b5cf6)', values: shown.metrics },
              ...(shown.baselineMetrics?.f1 != null ? [{ name: 'base model (live rules)', color: '#64748b', values: shown.baselineMetrics }] : [])
            ]} />
            {!shown.baselineMetrics?.f1 && <div className="card-hint">No base-model comparison: this dataset's features do not exist in live payments.</div>}
          </div>
          <div className="card">
            <div className="card-title"><h3><span className="ico">📦</span> Result</h3></div>
            <div className="kpi-row compact">
              <Kpi label="F1" value={fmt(shown.metrics.f1)} />
              <Kpi label="PR-AUC" value={fmt(shown.metrics.prAuc)} />
              <Kpi label="Recall" value={fmt(shown.metrics.recall)} />
              <Kpi label="Precision" value={fmt(shown.metrics.precision)} />
            </div>
            {(() => {
              const c = shown.stages?.find((x) => x.key === 'evaluate_register')?.output?.confusion;
              return c ? <><div className="section-label">Test set outcomes (cut-off 0.5)</div><Confusion c={c} /></> : null;
            })()}
            {shown.baselineMetrics?.prAuc != null && (
              <div className={`flash ${shown.metrics.prAuc > shown.baselineMetrics.prAuc ? 'ok' : 'warn'}`} style={{ marginTop: 12 }}>
                <span>{shown.metrics.prAuc > shown.baselineMetrics.prAuc ? '📈' : '📉'}</span>
                <div>PR-AUC {fmt(shown.metrics.prAuc)} vs base model {fmt(shown.baselineMetrics.prAuc)} ({shown.metrics.prAuc > shown.baselineMetrics.prAuc ? 'better' : 'not better'}).
                  {shown.dataset === 'platform_transactions' && ' Platform labels come from the base model’s own decisions, so it naturally scores well here.'}</div>
              </div>
            )}
            <div className="link-row">
              {shown.registeredVersion && <span className="badge INFO">{shown.registeredModel} v{shown.registeredVersion}</span>}
              <ExtLink href={host && shown.mlflowExperimentId && shown.mlflowRunId && `${host}/ml/experiments/${shown.mlflowExperimentId}/runs/${shown.mlflowRunId}`}>MLflow run</ExtLink>
              <ExtLink href={host && shown.registeredModel && `${host}/explore/data/models/${shown.registeredModel.replaceAll('.', '/')}`}>Model in Unity Catalog</ExtLink>
              <ExtLink href={host && shown.databricksJobId && shown.databricksRunId && `${host}/jobs/${shown.databricksJobId}/runs/${shown.databricksRunId}`}>Job run</ExtLink>
            </div>
            <div className="card-hint">Registering does not activate the model — live payments keep using the base model until a model is deployed to the fraud engine.</div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-title"><h3><span className="ico">🕘</span> Run history & comparison</h3><span className="faint" style={{ fontSize: 12 }}>click a run to inspect it</span></div>
        {completed.length > 1 && (
          <div className="history-chart">
            {completed.slice(0, 12).reverse().map((r) => (
              <div key={r._id} className="hc-col" title={`${r.modelType} · ${r.dataset}\nF1 ${fmt(r.metrics.f1)} · PR-AUC ${fmt(r.metrics.prAuc)}`} onClick={() => setViewRun(r._id)}>
                <div className="hc-bars">
                  <div className="hc-bar f1" style={{ height: `${(r.metrics.f1 || 0) * 100}%` }} />
                  <div className="hc-bar pr" style={{ height: `${(r.metrics.prAuc || 0) * 100}%` }} />
                  {r.baselineMetrics?.prAuc != null && <div className="hc-base" style={{ bottom: `${r.baselineMetrics.prAuc * 100}%` }} />}
                </div>
                <div className="hc-label">{r.modelType?.split('_').map((w) => w[0].toUpperCase()).join('')}</div>
              </div>
            ))}
            <div className="hc-legend"><span><i className="f1" />F1</span><span><i className="pr" />PR-AUC</span><span><i className="base" />base model PR-AUC</span></div>
          </div>
        )}
        {runs.length === 0 ? <Empty icon="🕘" title="No history" text="Every run you start is listed here with its metrics." /> : (
          <div className="table-wrap"><table className="data clickable">
            <thead><tr><th>Started</th><th>Model</th><th>Dataset</th><th>Status</th><th>F1</th><th>PR-AUC</th><th>ROC-AUC</th><th>Base PR-AUC</th><th>Duration</th><th>Version</th></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r._id} onClick={() => setViewRun(r._id)} className={shown?._id === r._id ? 'sel' : ''}>
                <td className="faint" style={{ whiteSpace: 'nowrap' }}>{timeAgo(r.createdAt)}</td>
                <td><b>{r.modelType?.replaceAll('_', ' ') || r.championModel || '—'}</b></td>
                <td className="faint">{r.dataset?.replaceAll('_', ' ') || '—'}</td>
                <td><span className={`badge ${r.status === 'COMPLETED' ? 'LOW' : r.status === 'FAILED' ? 'BLOCKED' : 'MEDIUM'}`}>{r.status}</span></td>
                <td>{fmt(r.metrics?.f1)}</td><td>{fmt(r.metrics?.prAuc)}</td><td>{fmt(r.metrics?.rocAuc)}</td>
                <td className="faint">{fmt(r.baselineMetrics?.prAuc)}</td>
                <td className="faint">{duration(r.startedAt, r.finishedAt)}</td>
                <td>{r.registeredVersion ? `v${r.registeredVersion}` : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-title"><h3><span className="ico">🔬</span> MLflow experiment</h3><ExtLink href={host && mlflow?.experiment && `${host}/ml/experiments/${mlflow.experiment.id}`}>Open</ExtLink></div>
          {!mlflow ? <p className="faint">Loading from Databricks MLflow…</p> : !mlflow.experiment ? <Empty icon="🔬" title="No experiment yet" text="Created by the first training run." /> : (
            <table className="data"><thead><tr><th>Run</th><th>Status</th><th>F1</th><th>PR-AUC</th><th>When</th></tr></thead>
              <tbody>{mlflow.runs.slice(0, 8).map((r) => (
                <tr key={r.runId}><td>{host ? <a href={`${host}/ml/experiments/${mlflow.experiment.id}/runs/${r.runId}`} target="_blank" rel="noopener noreferrer">{r.runName || r.runId.slice(0, 8)}</a> : r.runName}</td>
                  <td className="faint">{r.status}</td><td>{fmt(r.metrics.f1)}</td><td>{fmt(r.metrics.pr_auc)}</td><td className="faint">{timeAgo(r.startTime)}</td></tr>
              ))}</tbody></table>
          )}
        </div>
        <div className="card">
          <div className="card-title"><h3><span className="ico">🏷️</span> Registered versions</h3><span className="mono">{mlflow?.registeredModel}</span></div>
           {!mlflow ? <p className="faint">Loading from Unity Catalog…</p> : !mlflow.modelVersions?.length ? <Empty icon="🏷️" title="No versions yet" text="Each successful run registers a new version in Unity Catalog." /> : (
            <table className="data"><thead><tr><th>Version</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>{mlflow.modelVersions.map((v) => <tr key={v.version}><td><b>v{v.version}</b></td><td className="faint">{v.status}</td><td className="faint">{timeAgo(v.createdAt)}</td></tr>)}</tbody></table>
          )}
          <div className="card-hint">Live scoring uses: <b>{system?.fraudEngine?.mode === 'ML_MODEL' ? 'a local ML model' : system?.fraudEngine?.reachable ? 'the base model (rule-based heuristic)' : 'fallback rules (engine offline)'}</b>.</div>
        </div>
      </div>

      {stageAsk && (
        <Confirm title="Stage the credit-card benchmark?" confirmLabel="Download and upload" busy={busy === 'stage'} onCancel={() => setStageAsk(false)} onConfirm={stage}>
          The API server downloads OpenML dataset 1597 (~73 MB parquet) and writes it into your Unity Catalog landing volume. No compute runs. openml.org is often slow (it can take 10–40 minutes); the download continues in the background and the progress shows on this page.
        </Confirm>
      )}
      {confirm && (
        <Confirm title="Start a training run?" confirmLabel="Start on Databricks" busy={busy === 'start'} onCancel={() => setConfirm(false)} onConfirm={start}>
          <b>{options?.models?.find((m) => m.id === model)?.label}</b> on <b>{ds?.label}</b>. Runs job <span className="mono">sentinelpay-model-training</span> on your Databricks serverless compute (uses workspace compute; Free Edition queues it if another job is running).
        </Confirm>
      )}
    </>
  );
}
