import React from 'react';
import { int, timeAgo, duration } from './ui.jsx';

/**
 * Data-engineering visuals fed by /admin/dataflow (and training runs).
 * Every number comes from MongoDB, the Databricks Jobs API or Unity Catalog;
 * a missing value is shown as missing, never estimated.
 */

const sec = (a, b) => (a && b ? Math.max(0, (new Date(b) - new Date(a)) / 1000) : null);
const fmtS = (s) => (s == null ? '—' : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
const TASK_COLOR = { bronze: '#cd7f32', silver: '#8e9bb3', gold: '#e0a91b', load_dataset: '#3b82f6', build_features: '#8b5cf6', train_model: '#f59e0b', evaluate_register: '#10b981' };

/* ---------- where the data is now ---------- */

function Queue({ n, label, running }) {
  const blocks = Math.min(n || 0, 12);
  return (
    <div className={`sm-queue ${n ? 'has' : ''} ${running ? 'run' : ''}`} title={n ? `${n} row(s) ${label}` : `nothing ${label}`}>
      <div className="sm-belt">
        {Array.from({ length: blocks }).map((_, i) => <i key={i} style={{ animationDelay: `${i * 0.12}s` }} />)}
        {n > 12 && <em>+{n - 12}</em>}
      </div>
      <div className="sm-qlabel">{n ? <><b>{int(n)}</b> {label}</> : running ? 'processing…' : `none ${label}`}</div>
    </div>
  );
}

const ICON = { source: '🗄️', landing: '📦', bronze: '🥉', silver: '🥈', gold: '🥇' };
const UNIT = { source: 'transactions', landing: 'rows landed', bronze: 'raw events', silver: 'clean events', gold: 'predictions' };

/** MongoDB → landing → Bronze → Silver → Gold with real counts, backlogs and freshness. */
export function StageMap({ flow, compact }) {
  if (!flow) return <div className="faint">Loading data flow…</div>;
  const s = Object.fromEntries(flow.stages.map((x) => [x.id, x]));
  const latest = flow.runs?.[0];
  const running = latest && ['PENDING', 'QUEUED', 'RUNNING'].includes(latest.state);
  const task = (k) => latest?.tasks?.find((t) => t.key === k);
  const busy = (k) => running && ['RUNNING', 'PENDING'].includes(task(k)?.state);
  const card = (id, extra) => {
    const st = s[id];
    const stale = id === 'landing' ? st.waitingIn > 0 : ['bronze', 'silver', 'gold'].includes(id) ? flow.goldBehind > 0 : false;
    return (
      <div className={`sm-stage ${id} ${busy(id) ? 'busy' : ''}`}>
        <div className="sm-head"><span className="sm-ico">{ICON[id]}</span><span className="sm-name">{st.label}</span></div>
        <div className="sm-rows">{st.rows == null ? <span className="faint">not created</span> : int(st.rows)}</div>
        <div className="sm-unit">{UNIT[id]}</div>
        <div className={`sm-fresh ${busy(id) ? 'run' : stale ? 'stale' : 'ok'}`}>
          {busy(id) ? `${id} task running` : st.freshAt ? `${id === 'source' ? 'newest' : id === 'landing' ? 'last file' : 'built'} ${timeAgo(st.freshAt)}` : 'never'}
        </div>
        {extra}
      </div>
    );
  };
  return (
    <div className={`stage-map ${compact ? 'compact' : ''}`}>
      {card('source', (s.source.notExported?.awaitingCustomer || s.source.notExported?.stuck) ? (
        <div className="sm-note">held back: {s.source.notExported.awaitingCustomer} awaiting customer{s.source.notExported.stuck ? <> · <b className="bad">{s.source.notExported.stuck} stuck</b></> : ''}</div>
      ) : null)}
      <Queue n={s.landing.waitingIn} label="waiting to land" />
      {card('landing')}
      <Queue n={s.bronze.waitingIn} label="waiting for Bronze" running={busy('bronze')} />
      {card('bronze')}
      <div className={`sm-link ${busy('silver') ? 'run' : ''}`}><span>clean + validate</span></div>
      {card('silver', <div className="sm-note">{s.silver.quarantined ? <b className="warn">{int(s.silver.quarantined)} quarantined</b> : '0 quarantined'}</div>)}
      <div className={`sm-link ${busy('gold') ? 'run' : ''}`}><span>aggregate</span></div>
      {card('gold', <div className="sm-note">{flow.goldBehind ? <b className="warn">behind by {int(flow.goldBehind)} payment{flow.goldBehind === 1 ? '' : 's'}</b> : 'up to date'}</div>)}
    </div>
  );
}

/* ---------- where the rows went in the last run ---------- */

/** Sankey of the last successful medallion run, from the notebooks' own exit values. */
export function Reconciliation({ rec }) {
  if (!rec?.bronze || !rec?.silver || !rec?.gold) {
    return <div className="faint" style={{ fontSize: 13 }}>No successful pipeline run with recorded outputs yet.</div>;
  }
  const b = rec.bronze; const sv = rec.silver; const g = rec.gold;
  const dupes = Math.max(0, sv.input_rows - sv.silver_rows - sv.quarantined);
  const noDecision = Math.max(0, sv.silver_rows - g.predictions);
  const cols = [
    [{ id: 'before', label: 'Already in Bronze', v: b.rows_before }, { id: 'new', label: 'Ingested this run', v: b.new_rows, c: '#f97316' }],
    [{ id: 'bronze', label: 'Bronze', v: b.rows_after, c: '#cd7f32' }],
    [{ id: 'silver', label: 'Silver (clean)', v: sv.silver_rows, c: '#8e9bb3' }, { id: 'quar', label: 'Quarantined', v: sv.quarantined, c: '#ef4444' }, { id: 'dup', label: 'Duplicates dropped', v: dupes, c: '#94a3b8' }],
    [{ id: 'pred', label: 'Gold predictions', v: g.predictions, c: '#e0a91b' }, { id: 'other', label: 'No decision (not a prediction)', v: noDecision, c: '#94a3b8' }]
  ];
  const links = [['before', 'bronze'], ['new', 'bronze'], ['bronze', 'silver'], ['bronze', 'quar'], ['bronze', 'dup'], ['silver', 'pred'], ['silver', 'other']];
  const W = 900; const H = 240; const NW = 14; const GAP = 24; const TOP = 10;
  const colX = [170, 330, 520, 680];
  const maxTot = Math.max(...cols.map((c) => c.reduce((a, n) => a + n.v, 0)), 1);
  const scale = (H - TOP * 2 - GAP * 2) / maxTot;
  const pos = {};
  cols.forEach((col, ci) => {
    const tot = col.reduce((a, n) => a + Math.max(n.v * scale, 2), 0) + GAP * (col.length - 1);
    let y = (H - tot) / 2;
    col.forEach((n) => { const h = Math.max(n.v * scale, 2); pos[n.id] = { ...n, x: colX[ci], y, h, out: 0, in: 0 }; y += h + GAP; });
  });
  const val = Object.fromEntries(cols.flat().map((n) => [n.id, n.v]));
  const flowV = { before: val.before, new: val.new, bronze_silver: val.silver, bronze_quar: val.quar, bronze_dup: val.dup, silver_pred: val.pred, silver_other: val.other };
  const paths = links.map(([a, z]) => {
    const v = flowV[a === 'bronze' || a === 'silver' ? `${a}_${z}` : a] ?? 0;
    const w = v ? Math.max(v * scale, 1.5) : 0;
    const A = pos[a]; const Z = pos[z];
    const y0 = A.y + A.out + w / 2; const y1 = Z.y + Z.in + w / 2;
    A.out += w; Z.in += w;
    const x0 = A.x + NW; const x1 = Z.x; const mx = (x0 + x1) / 2;
    return { key: `${a}-${z}`, d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`, w, c: pos[z].c || pos[a].c || '#94a3b8', v };
  });
  const checks = [
    ['Bronze rows = Silver input', b.rows_after === sv.input_rows, `${int(b.rows_after)} vs ${int(sv.input_rows)}`],
    ['Silver input = clean + quarantined + duplicates', sv.input_rows === sv.silver_rows + sv.quarantined + dupes, `${int(sv.input_rows)} = ${int(sv.silver_rows)} + ${int(sv.quarantined)} + ${int(dupes)}`],
    ['Before + ingested = Bronze', b.rows_before + b.new_rows === b.rows_after, `${int(b.rows_before)} + ${int(b.new_rows)} = ${int(b.rows_after)}`]
  ];
  return (
    <div className="recon">
      <svg viewBox={`0 0 ${W} ${H}`} className="sankey" role="img" aria-label="Row flow of the last pipeline run">
        {paths.map((p) => p.w > 0 && <path key={p.key} d={p.d} stroke={p.c} strokeWidth={p.w} fill="none" opacity="0.38"><title>{`${int(p.v)} rows`}</title></path>)}
        {Object.values(pos).map((n) => {
          const left = n.x < 250;
          return (
            <g key={n.id}>
              <rect x={n.x} y={n.y} width={NW} height={n.h} rx="3" fill={n.c || '#64748b'} opacity={n.v ? 1 : 0.35} />
              <text x={left ? n.x - 8 : n.x + NW + 8} y={n.y + n.h / 2} textAnchor={left ? 'end' : 'start'} dominantBaseline="middle" className="sk-label">
                <tspan className="sk-v">{int(n.v)}</tspan> {n.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="recon-checks">
        {checks.map(([t, ok, d]) => <span key={t} className={ok ? 'ok' : 'bad'} title={d}>{ok ? '✓' : '✗'} {t}</span>)}
        <span className="faint">gold also built {int(g.users)} user profiles · {int(g.kpi_hours)} KPI hours · run {timeAgo(rec.endTime)}</span>
      </div>
    </div>
  );
}

/* ---------- how long each step takes ---------- */

/**
 * Gantt of recent job runs: the grey part is the wait before the first task
 * (queue + serverless start-up), then one coloured segment per task.
 */
export function RunTimeline({ runs, order, host, jobId, now = Date.now() }) {
  if (!runs?.length) return <div className="faint" style={{ fontSize: 13 }}>No runs yet.</div>;
  const rows = runs.map((r) => {
    const end = r.endTime || new Date(now).toISOString();
    const tasks = order.map((k) => r.tasks.find((t) => t.key === k)).filter(Boolean);
    const firstStart = tasks.map((t) => t.startedAt).filter(Boolean).sort()[0];
    return { r, end, total: sec(r.startTime, end), wait: sec(r.startTime, firstStart || end), tasks };
  });
  const max = Math.max(...rows.map((x) => x.total || 0), 1);
  return (
    <div className="gantt">
      {rows.map(({ r, end, total, wait, tasks }) => {
        const live = !r.endTime;
        const tone = r.result === 'SUCCESS' ? 'ok' : r.result ? 'bad' : 'run';
        const link = host && jobId ? `${host}/jobs/${jobId}/runs/${r.runId}` : null;
        return (
          <div key={r.runId} className="g-row">
            <div className="g-meta">
              <span className={`sdot ${tone}`} />
              {link ? <a href={link} target="_blank" rel="noopener noreferrer">{new Date(r.startTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</a> : new Date(r.startTime).toLocaleString()}
              <span className="faint">{r.result || r.state} · {fmtS(total)}</span>
            </div>
            <div className="g-track">
              <div className="g-bar" style={{ width: `${((total || 0) / max) * 100}%` }}>
                <i className="g-wait" style={{ flexGrow: wait || 0 }} title={`waiting for compute ${fmtS(wait)}`} />
                {tasks.map((t) => {
                  const d = sec(t.startedAt, t.finishedAt || (live && t.startedAt ? end : null));
                  return d ? <i key={t.key} className={`g-seg ${!t.finishedAt ? 'live' : ''} ${t.result && t.result !== 'SUCCESS' ? 'failed' : ''}`} style={{ flexGrow: d, background: TASK_COLOR[t.key] }} title={`${t.key}: ${fmtS(d)} · ${t.result || t.state}`}><span>{fmtS(d)}</span></i> : null;
                })}
              </div>
            </div>
          </div>
        );
      })}
      <div className="g-legend">
        <span><i className="g-wait" />waiting for compute</span>
        {order.map((k) => <span key={k}><i style={{ background: TASK_COLOR[k] }} />{k.replaceAll('_', ' ')}</span>)}
      </div>
    </div>
  );
}

/* ---------- hot path ---------- */

/** Payments per minute for the last 60 minutes, stacked by outcome. */
export function Throughput({ perMinute, now = Date.now() }) {
  const byMin = Object.fromEntries((perMinute || []).map((m) => [new Date(m.t).getTime(), m]));
  const end = Math.floor(now / 60000) * 60000;
  const mins = Array.from({ length: 60 }, (_, i) => end - (59 - i) * 60000);
  const rows = mins.map((t) => byMin[t] || { t, completed: 0, challenged: 0, blocked: 0, other: 0 });
  const max = Math.max(...rows.map((m) => m.completed + m.challenged + m.blocked + m.other), 1);
  return (
    <div className="tput">
      <div className="tput-bars">
        {rows.map((m) => {
          const tot = m.completed + m.challenged + m.blocked + m.other;
          return (
            <div key={m.t} className="tput-col" title={`${new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${tot} payment(s): ${m.completed} completed, ${m.challenged} challenged, ${m.blocked} blocked${m.other ? `, ${m.other} other` : ''}`}>
              <div style={{ height: `${(tot / max) * 100}%` }}>
                {m.blocked > 0 && <i className="b" style={{ flexGrow: m.blocked }} />}
                {m.challenged > 0 && <i className="c" style={{ flexGrow: m.challenged }} />}
                {m.other > 0 && <i className="o" style={{ flexGrow: m.other }} />}
                {m.completed > 0 && <i className="ok" style={{ flexGrow: m.completed }} />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="tput-axis"><span>60 min ago</span><span>30 min</span><span>now</span></div>
      <div className="g-legend"><span><i style={{ background: 'var(--success)' }} />completed</span><span><i style={{ background: 'var(--warn)' }} />challenged</span><span><i style={{ background: 'var(--danger)' }} />blocked</span><span><i style={{ background: '#94a3b8' }} />other</span></div>
    </div>
  );
}

export const ms = (v) => (v == null ? '—' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(2)} s`);

/* ---------- training run ---------- */

/** One training run as a Gantt: wait for compute, then each Databricks task. */
export function TrainingTimeline({ run, order }) {
  if (!run?.startedAt) return null;
  const tasks = (run.stages || []).map((s) => ({ key: s.key, startedAt: s.startedAt, finishedAt: s.finishedAt, result: s.result, state: s.state }));
  const fake = { runId: run._id, startTime: run.startedAt, endTime: run.finishedAt, state: run.status, result: run.status === 'COMPLETED' ? 'SUCCESS' : run.status === 'FAILED' ? 'FAILED' : null, tasks };
  return <RunTimeline runs={[fake]} order={order} />;
}

/** Confusion matrix of the held-out test split (from the evaluate task's output). */
export function Confusion({ c }) {
  if (!c) return null;
  const tot = c.tp + c.fp + c.tn + c.fn || 1;
  const cell = (v, cls, t) => <div className={`cm-cell ${cls}`} style={{ '--a': 0.15 + (v / tot) * 0.85 }} title={t}><b>{int(v)}</b><span>{t}</span></div>;
  return (
    <div className="cm">
      <div className="cm-grid">
        <div />
        <div className="cm-h">predicted fraud</div><div className="cm-h">predicted normal</div>
        <div className="cm-h side">actual fraud</div>{cell(c.tp, 'good', 'caught (TP)')}{cell(c.fn, 'bad', 'missed (FN)')}
        <div className="cm-h side">actual normal</div>{cell(c.fp, 'warn', 'false alarm (FP)')}{cell(c.tn, 'good', 'correct pass (TN)')}
      </div>
    </div>
  );
}

export { duration };
