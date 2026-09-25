import React, { useMemo, useState } from 'react';
import { useAdminData, PageHead, CompareBars, int, money, timeAgo } from '../ui.jsx';
import { StageMap, RunTimeline, ms } from '../flow.jsx';
import '../overview.css';

/**
 * Landing page: the platform in one screen. Every number and chart below is
 * read from the live API (MongoDB counts, the fraud engine's /health, the
 * Databricks Jobs API and the training runs); nothing is estimated.
 */

const HOUR = 3600e3;
const SERIES = [
  { k: 'completed', label: 'Completed', color: 'var(--success)' },
  { k: 'challenged', label: 'On hold', color: 'var(--warn)' },
  { k: 'blocked', label: 'Blocked', color: 'var(--danger)' },
  { k: 'other', label: 'Other', color: '#94a3b8' }
];
const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/* ---------- small visuals ---------- */

function Spark({ values, color = 'var(--primary)' }) {
  if (!values?.length || values.every((v) => !v)) return <svg className="ov-spark" viewBox="0 0 100 30" aria-hidden><line x1="0" y1="28" x2="100" y2="28" /></svg>;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 28 - (v / max) * 24]);
  const line = pts.map((p) => p.join(',')).join(' ');
  return (
    <svg className="ov-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden style={{ '--c': color }}>
      <polygon points={`0,30 ${line} 100,30`} />
      <polyline points={line} />
    </svg>
  );
}

function Ring({ value, color }) {
  return (
    <svg className="ov-ring" viewBox="0 0 36 36" aria-hidden style={{ '--c': color }}>
      <circle cx="18" cy="18" r="15" pathLength="100" />
      <circle cx="18" cy="18" r="15" pathLength="100" className="fill" style={{ strokeDasharray: `${Math.max(0, Math.min(100, value))} 100` }} />
    </svg>
  );
}

function Tile({ ico, label, value, sub, tone, children, onClick }) {
  return (
    <button type="button" className={`ov-tile ${tone || ''}`} onClick={onClick} disabled={!onClick}>
      <div className="ov-tile-top"><span className="ov-tile-ico">{ico}</span><span className="ov-tile-l">{label}</span></div>
      <div className="ov-tile-mid">
        <div className="ov-tile-v">{value}</div>
        {children}
      </div>
      {sub && <div className="ov-tile-sub">{sub}</div>}
    </button>
  );
}

function Section({ id, ico, title, sub }) {
  return (
    <div className="ov-sec" id={id}>
      <span className="ov-sec-ico">{ico}</span>
      <div><h3>{title}</h3>{sub && <div className="ov-sec-sub">{sub}</div>}</div>
    </div>
  );
}

/* ---------- traffic chart ---------- */

function hourBuckets(series, now) {
  const by = Object.fromEntries((series || []).map((s) => [new Date(s.hour).getTime(), s]));
  const end = Math.floor(now / HOUR) * HOUR;
  return Array.from({ length: 24 }, (_, i) => {
    const t = end - (23 - i) * HOUR;
    const s = by[t] || {};
    const completed = s.completed || 0; const challenged = s.challenged || 0; const blocked = s.blocked || 0;
    return { t, completed, challenged, blocked, other: Math.max(0, (s.total || 0) - completed - challenged - blocked) };
  });
}

function minuteBuckets(perMinute, now) {
  const by = Object.fromEntries((perMinute || []).map((m) => [new Date(m.t).getTime(), m]));
  const end = Math.floor(now / 60e3) * 60e3;
  return Array.from({ length: 60 }, (_, i) => {
    const t = end - (59 - i) * 60e3;
    const m = by[t] || {};
    return { t, completed: m.completed || 0, challenged: m.challenged || 0, blocked: m.blocked || 0, other: m.other || 0 };
  });
}

function TrafficChart({ pipeline, flow }) {
  const [range, setRange] = useState('24h');
  const [hidden, setHidden] = useState({});
  const [hover, setHover] = useState(null);
  const now = Date.now();
  const rows = range === '24h' ? hourBuckets(pipeline?.series, now) : minuteBuckets(flow?.hot?.perMinute, now);
  const shown = SERIES.filter((s) => !hidden[s.k]);
  const tot = (r) => shown.reduce((a, s) => a + r[s.k], 0);
  const max = Math.max(...rows.map(tot), 1);
  const sum = Object.fromEntries(SERIES.map((s) => [s.k, rows.reduce((a, r) => a + r[s.k], 0)]));
  const all = SERIES.reduce((a, s) => a + sum[s.k], 0);
  const h = hover != null ? rows[hover] : null;
  const fmtT = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const loading = range === '24h' ? !pipeline : !flow;

  return (
    <div className="card ov-traffic">
      <div className="card-title">
        <h3><span className="ico">📈</span> Payments over time</h3>
        <div className="seg" role="tablist">
          {[['24h', 'Last 24 h'], ['1h', 'Last hour']].map(([k, l]) => (
            <button key={k} role="tab" aria-selected={range === k} className={range === k ? 'on' : ''} onClick={() => { setRange(k); setHover(null); }}>{l}</button>
          ))}
        </div>
      </div>
      <div className="ov-tr-sum">
        <div><b>{loading ? '—' : int(all)}</b><span>payments</span></div>
        {SERIES.slice(0, 3).map((s) => <div key={s.k}><b style={{ color: s.color }}>{loading ? '—' : int(sum[s.k])}</b><span>{s.label.toLowerCase()}{loading ? '' : ` · ${pctOf(sum[s.k], all)}%`}</span></div>)}
      </div>
      {loading ? <div className="faint ov-tr-empty">Loading…</div> : (
        <div className="ov-tr-plot" onMouseLeave={() => setHover(null)}>
          <div className="ov-tr-grid"><span>{max}</span><span>{Math.round(max / 2)}</span><span>0</span></div>
          <div className="ov-tr-bars">
            {rows.map((r, i) => (
              <div key={r.t} className={`ov-tr-col ${hover === i ? 'on' : ''}`} onMouseEnter={() => setHover(i)}>
                <div className="ov-tr-stack" style={{ height: `${(tot(r) / max) * 100}%` }}>
                  {[...shown].reverse().map((s) => r[s.k] > 0 && <i key={s.k} style={{ flexGrow: r[s.k], background: s.color }} />)}
                </div>
              </div>
            ))}
          </div>
          {h && (
            <div className="ov-tip" style={{ left: `${((hover + 0.5) / rows.length) * 100}%` }}>
              <div className="ov-tip-t">{range === '24h' ? `${fmtT(h.t)} – ${fmtT(h.t + HOUR)}` : fmtT(h.t)}</div>
              {SERIES.map((s) => <div key={s.k} className={hidden[s.k] ? 'off' : ''}><i style={{ background: s.color }} />{s.label}<b>{h[s.k]}</b></div>)}
            </div>
          )}
          {all === 0 && <div className="ov-tr-none">No payments in this window.</div>}
        </div>
      )}
      <div className="ov-tr-axis">
        <span>{range === '24h' ? '24 h ago' : '60 min ago'}</span><span>{range === '24h' ? '12 h' : '30 min'}</span><span>now</span>
      </div>
      <div className="ov-legend">
        {SERIES.map((s) => (
          <button key={s.k} className={hidden[s.k] ? 'off' : ''} onClick={() => setHidden((x) => ({ ...x, [s.k]: !x[s.k] }))} title={hidden[s.k] ? 'Show' : 'Hide'}>
            <i style={{ background: s.color }} />{s.label}
          </button>
        ))}
        <span className="faint">click a colour to hide it</span>
      </div>
    </div>
  );
}

/* ---------- decision mix ---------- */

function DecisionMix({ stats, flow, go }) {
  const [hi, setHi] = useState(null);
  const total = stats?.totalTx || 0;
  const parts = [
    { k: 'completed', label: 'Completed', v: stats?.completed || 0, color: 'var(--success)' },
    { k: 'challenged', label: 'On hold', v: stats?.challenged || 0, color: 'var(--warn)' },
    { k: 'blocked', label: 'Blocked', v: stats?.blocked || 0, color: 'var(--danger)' }
  ];
  parts.push({ k: 'other', label: 'Other (failed / pending)', v: Math.max(0, total - parts.reduce((a, p) => a + p.v, 0)), color: '#94a3b8' });
  let acc = 0;
  const segs = parts.map((p) => { const len = total ? (p.v / total) * 100 : 0; const s = { ...p, len, off: acc }; acc += len; return s; });
  const focus = hi ? parts.find((p) => p.k === hi) : null;
  const sources = Object.entries(flow?.hot?.sources24h || {});
  const srcTotal = sources.reduce((a, [, n]) => a + n, 0);

  return (
    <div className="card ov-mix">
      <div className="card-title"><h3><span className="ico">🍩</span> Decision mix</h3><span className="faint" style={{ fontSize: 12 }}>all time</span></div>
      <div className="ov-mix-body">
        <svg viewBox="0 0 120 120" className="ov-donut" onMouseLeave={() => setHi(null)}>
          <circle cx="60" cy="60" r="46" className="track" pathLength="100" />
          {segs.map((s) => s.len > 0 && (
            <circle key={s.k} cx="60" cy="60" r="46" pathLength="100" className={`seg ${hi && hi !== s.k ? 'dim' : ''}`}
              style={{ stroke: s.color, strokeDasharray: `${Math.max(s.len - 0.6, 0.4)} ${100 - Math.max(s.len - 0.6, 0.4)}`, strokeDashoffset: -s.off }}
              onMouseEnter={() => setHi(s.k)} />
          ))}
          <text x="60" y="57" className="big">{focus ? `${pctOf(focus.v, total)}%` : int(total)}</text>
          <text x="60" y="73" className="small">{focus ? focus.label.split(' ')[0].toLowerCase() : 'payments'}</text>
        </svg>
        <div className="ov-mix-list">
          {parts.map((p) => (
            <button key={p.k} className={hi === p.k ? 'on' : ''} onMouseEnter={() => setHi(p.k)} onMouseLeave={() => setHi(null)} onClick={() => go('transactions')}>
              <i style={{ background: p.color }} /><span>{p.label}</span><b>{int(p.v)}</b><em>{pctOf(p.v, total)}%</em>
            </button>
          ))}
        </div>
      </div>
      <div className="ov-src">
        <div className="ov-src-h">Who decided (last 24 h)</div>
        {!flow ? <div className="faint" style={{ fontSize: 12.5 }}>Loading…</div> : srcTotal === 0 ? <div className="faint" style={{ fontSize: 12.5 }}>No scored payments in the last 24 h.</div> : (
          <>
            <div className="ov-src-bar">{sources.map(([k, n]) => <i key={k} className={k} style={{ flexGrow: n }} title={`${k}: ${n}`} />)}</div>
            <div className="ov-src-leg">{sources.map(([k, n]) => <span key={k}><i className={k} />{k === 'ML_MODEL' ? 'ML model' : k === 'HEURISTIC' ? 'Rule engine' : k === 'FALLBACK' ? 'Fallback rules' : k}<b>{int(n)}</b></span>)}</div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- latency ---------- */

function Latency({ lat }) {
  if (!lat?.samples) return <div className="faint" style={{ fontSize: 13 }}>No timed payments yet.</div>;
  const max = Math.max(lat.totalMax || 0, lat.totalP95 || 0, 1);
  const rows = [
    ['Fraud check · typical', lat.scoreP50, 'score'],
    ['Fraud check · slowest 5%', lat.scoreP95, 'score'],
    ['Whole payment · typical', lat.totalP50, 'total'],
    ['Whole payment · slowest 5%', lat.totalP95, 'total'],
    ['Whole payment · slowest', lat.totalMax, 'max']
  ];
  return (
    <div className="ov-lat">
      {rows.map(([l, v, c]) => (
        <div key={l} className="ov-lat-row">
          <span className="ov-lat-l">{l}</span>
          <span className="ov-lat-track"><i className={c} style={{ width: `${v == null ? 0 : Math.max((v / max) * 100, 2)}%` }} /></span>
          <b>{ms(v)}</b>
        </div>
      ))}
      <div className="faint ov-lat-foot">{lat.samples} payments measured since {timeAgo(lat.since)}</div>
    </div>
  );
}

/* ---------- live activity ---------- */

function LiveTable({ recent, liveFeed, go }) {
  const rows = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const e of liveFeed.filter((x) => !x._alert)) {
      if (seen.has(e.txId)) continue;
      seen.add(e.txId);
      out.push({ ...e, when: e._at, fresh: Date.now() - new Date(e._at).getTime() < 15000 });
    }
    for (const t of recent || []) {
      if (seen.has(t.txId)) continue;
      seen.add(t.txId);
      out.push({ ...t, when: t.createdAt, who: t.userId?.email });
    }
    return out.slice(0, 8);
  }, [recent, liveFeed]);

  if (!rows.length) return <div className="faint" style={{ padding: '30px 0', textAlign: 'center' }}>{recent ? 'No payments yet.' : 'Loading…'}</div>;
  return (
    <div className="ov-live">
      {rows.map((r) => {
        const p = r.fraudProbability;
        const tone = p == null ? '' : p >= 0.7 ? 'bad' : p >= 0.3 ? 'warn' : 'ok';
        return (
          <button key={r.txId} className={`ov-live-row ${r.fresh ? 'fresh' : ''}`} onClick={() => go('transactions')}>
            <span className={`ov-live-dot ${r.status}`} />
            <span className="ov-live-id"><span className="mono">{r.txId}</span><span className="faint">{r.who || (r.fresh ? 'just now · live' : '')}</span></span>
            <span className="ov-live-amt">{money(r.amount)}</span>
            <span className={`badge ${r.status}`}>{r.status}</span>
            <span className={`ov-risk ${tone}`} title={p == null ? 'not scored' : `fraud risk ${Math.round(p * 100)}%`}>
              <i style={{ width: `${p == null ? 0 : Math.max(p * 100, 3)}%` }} /><em>{p == null ? '—' : `${Math.round(p * 100)}%`}</em>
            </span>
            <span className="faint ov-live-when">{timeAgo(r.when)}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------- model ---------- */

function ModelCard({ training, fe, go }) {
  const cur = training?.current;
  const done = training?.lastCompleted;
  const running = cur && ['PENDING', 'QUEUED', 'RUNNING'].includes(cur.status);
  const serving = fe?.mode === 'ML_MODEL';
  return (
    <div className="card ov-model">
      <div className="card-title"><h3><span className="ico">🧠</span> Latest fraud model</h3><button className="btn ghost sm" onClick={() => go('training')}>Training</button></div>
      {!training ? <div className="faint">Loading…</div> : !done ? (
        <div className="faint" style={{ fontSize: 13 }}>No completed training run yet. {cur?.status === 'FAILED' ? `The last run failed: ${cur.stateMessage || 'see Training'}.` : 'Start one from the Training tab.'}</div>
      ) : (
        <>
          <div className="ov-model-head">
            <div className="ov-model-name">{done.championModel || done.modelType}<span>{done.registeredModel ? ` · v${done.registeredVersion}` : ''}</span></div>
            <div className="ov-model-meta">
              <span>📚 {done.dataset}</span>
              <span>🕒 trained {timeAgo(done.finishedAt)}</span>
              {done.registeredModel && <span className="mono">{done.registeredModel}</span>}
            </div>
          </div>
          <div className={`ov-serving ${serving ? 'ok' : 'warn'}`}>
            {serving ? '✅ The fraud engine is serving an ML model.' : fe?.reachable
              ? '⚠️ Registered, but not serving yet: live payments are scored by the rule engine.'
              : '🛑 Fraud engine offline: payments use the fallback rules.'}
          </div>
          {running && <div className="ov-serving run">⏳ A new training run is {cur.status.toLowerCase()} ({cur.modelType}).</div>}
          <CompareBars
            metrics={[['precision', 'Precision'], ['recall', 'Recall'], ['f1', 'F1'], ['rocAuc', 'ROC AUC'], ['prAuc', 'PR AUC']]}
            series={[
              { name: done.championModel || done.modelType, values: done.metrics, color: 'var(--primary)' },
              done.baselineMetrics && { name: 'baseline', values: done.baselineMetrics, color: '#94a3b8' }
            ].filter(Boolean)}
          />
        </>
      )}
    </div>
  );
}

/* ---------- page ---------- */

export default function OverviewPage({ go, liveFeed }) {
  const { data } = useAdminData({ stats: '/admin/stats', system: '/admin/system', pipeline: '/admin/pipeline', training: '/admin/training', flow: '/admin/dataflow', recent: '/admin/transactions?limit=10' }, 10000);
  const { stats, system, pipeline, training, flow, recent } = data;
  const lake = pipeline?.lakehouse;
  const jobs = pipeline?.databricks?.jobs ?? [];
  const medJob = jobs.find((j) => j.name?.includes('medallion'));
  const fe = system?.fraudEngine;
  const cur = training?.current;
  const lastRun = flow?.runs?.[0];
  const lat = flow?.hot?.latency;
  const hours = hourBuckets(pipeline?.series, Date.now());

  const todo = [
    stats?.pendingUsers > 0 && { sev: 'warn', ico: '⏳', text: `${stats.pendingUsers} user(s) waiting for approval`, go: 'users' },
    stats?.challenged > 0 && { sev: 'warn', ico: '⚠️', text: `${stats.challenged} payment(s) waiting for the customer's answer`, go: 'transactions' },
    flow?.goldBehind > 0 && { sev: 'info', ico: '📦', text: `Gold is behind by ${flow.goldBehind} payment(s): ${lake?.pending ? `${lake.pending} not landed` : ''}${lake?.pending && flow.goldBehind > lake.pending ? ' · ' : ''}${flow.goldBehind > (lake?.pending || 0) ? `${flow.goldBehind - (lake?.pending || 0)} landed, waiting for a pipeline run` : ''}`, go: 'pipeline' },
    flow?.hot?.stuck > 0 && { sev: 'bad', ico: '🧊', text: `${flow.hot.stuck} payment(s) stuck before scoring (hold still placed)`, go: 'transactions' },
    pipeline && !medJob && { sev: 'warn', ico: '🧱', text: 'Databricks jobs are not deployed yet', go: 'databricks' },
    fe && !fe.reachable && { sev: 'bad', ico: '🛑', text: 'Fraud engine offline: payments use fallback rules', go: 'system' },
    cur?.status === 'FAILED' && { sev: 'bad', ico: '⛔', text: `Last training run failed: ${cur.stateMessage || ''}`.slice(0, 120), go: 'training' }
  ].filter(Boolean);

  const runState = !flow ? 'idle' : !lastRun ? 'idle' : !lastRun.endTime ? 'run' : lastRun.result === 'SUCCESS' ? 'ok' : 'bad';
  const services = [
    { ico: '🗄️', name: 'MongoDB', go: 'system', state: !system ? 'idle' : system.mongo?.connected ? 'ok' : 'bad', val: !system ? '…' : system.mongo?.connected ? 'connected' : 'down' },
    { ico: '🛡️', name: 'Fraud engine', go: 'system', state: !fe ? 'idle' : !fe.reachable ? 'bad' : 'ok', val: !fe ? '…' : !fe.reachable ? 'offline' : `${fe.mode === 'ML_MODEL' ? 'ML model' : 'rules'}${lat?.scoreP50 != null ? ` · ${lat.scoreP50} ms` : ''}` },
    { ico: '📨', name: 'Kafka', go: 'system', state: !system ? 'idle' : system.kafka?.enabled ? 'ok' : 'off', val: !system ? '…' : system.kafka?.enabled ? 'streaming' : 'off (direct)' },
    { ico: '🧱', name: 'Databricks', go: 'databricks', state: !system ? 'idle' : system.databricks?.hostConfigured && system.databricks?.tokenConfigured ? 'ok' : 'warn', val: !system ? '…' : system.databricks?.hostConfigured && system.databricks?.tokenConfigured ? 'connected' : 'not configured' },
    { ico: '🌊', name: 'Pipeline', go: 'pipeline', state: runState, val: !flow ? '…' : !lastRun ? 'never run' : !lastRun.endTime ? 'running…' : `${lastRun.result === 'SUCCESS' ? 'ok' : (lastRun.result || 'failed').toLowerCase()} · ${timeAgo(lastRun.endTime)}` },
    { ico: '🧠', name: 'Model', go: 'training', state: !training ? 'idle' : !cur ? 'idle' : cur.status === 'COMPLETED' ? 'ok' : cur.status === 'FAILED' ? 'bad' : 'run', val: !training ? '…' : !cur ? 'none yet' : cur.status === 'COMPLETED' ? `${cur.modelType}${cur.registeredVersion ? ` v${cur.registeredVersion}` : ''}` : cur.status.toLowerCase() }
  ];
  const down = services.filter((s) => s.state === 'bad').length;
  const mood = down ? 'bad' : todo.length ? 'warn' : 'ok';
  const headline = down ? `${down} service${down > 1 ? 's' : ''} down` : todo.length ? `Running · ${todo.length} thing${todo.length > 1 ? 's' : ''} need${todo.length > 1 ? '' : 's'} a look` : 'All systems healthy';

  const total = stats?.totalTx || 0;
  const approve = pctOf(stats?.completed || 0, total);
  const blockRate = pctOf(stats?.blocked || 0, total);
  const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="ov">
      <PageHead title="From payment to prediction" sub="Every transfer is scored in real time, landed in the Databricks lakehouse, refined through Bronze → Silver → Gold, and used to train the next fraud model.">
        <button className="btn sm" onClick={() => go('architecture')}>Open live data flow</button>
        <button className="btn ghost sm" onClick={() => go('pipeline')}>Data pipeline</button>
        <button className="btn ghost sm" onClick={() => go('training')}>Train a model</button>
      </PageHead>

      {/* ---- health ---- */}
      <div className={`ov-hero ${mood}`}>
        <div className="ov-hero-main">
          <div className="ov-hero-kicker"><span className="ov-pulse" />Platform health · refreshed every 10 s</div>
          <div className="ov-hero-h">{headline}</div>
          <div className="ov-svcs">
            {services.map((s) => (
              <button key={s.name} className={`ov-svc ${s.state}`} onClick={() => go(s.go)} title={`Open ${s.go}`}>
                <span className="ov-svc-ico">{s.ico}</span>
                <span className="ov-svc-txt"><b>{s.name}</b><span>{s.val}</span></span>
                <span className="ov-svc-dot" />
              </button>
            ))}
          </div>
          <div className="ov-jump">
            <span>Jump to</span>
            {[['ov-traffic', '📈 Traffic'], ['ov-platform', '🌊 Data platform'], ['ov-live', '⚡ Live & model']].map(([id, l]) => <button key={id} onClick={() => jump(id)}>{l}</button>)}
          </div>
        </div>
        <div className="ov-hero-todo">
          <div className="ov-todo-h">📋 Needs attention {todo.length > 0 && <span className="ov-count">{todo.length}</span>}</div>
          {todo.length === 0
            ? <div className="ov-allclear">✨ All clear: no pending approvals, stuck payments or pipeline backlog.</div>
            : todo.map((t, i) => (
              <button key={i} className={`ov-todo ${t.sev}`} onClick={() => go(t.go)}>
                <span>{t.ico}</span><span style={{ flex: 1 }}>{t.text}</span><span className="ov-go">›</span>
              </button>
            ))}
        </div>
      </div>

      {/* ---- KPIs ---- */}
      <div className="ov-tiles">
        <Tile ico="💳" label="Transactions" value={int(stats?.totalTx)} sub={pipeline ? `${int(pipeline.totals24h?.processed)} in the last 24 h` : '…'} onClick={() => go('transactions')}>
          <Spark values={hours.map((h) => h.completed + h.challenged + h.blocked + h.other)} />
        </Tile>
        <Tile ico="✅" label="Approved" tone="ok" value={stats ? `${approve}%` : '—'} sub={`${int(stats?.completed)} completed`} onClick={() => go('transactions')}>
          <Ring value={approve} color="var(--success)" />
        </Tile>
        <Tile ico="⚠️" label="On hold" tone="warn" value={int(stats?.challenged)} sub="waiting for the customer" onClick={() => go('transactions')}>
          <Spark values={hours.map((h) => h.challenged)} color="var(--warn)" />
        </Tile>
        <Tile ico="🚫" label="Blocked" tone="bad" value={int(stats?.blocked)} sub={stats ? `${blockRate}% of all payments` : '…'} onClick={() => go('transactions')}>
          <Spark values={hours.map((h) => h.blocked)} color="var(--danger)" />
        </Tile>
        <Tile ico="⚡" label="Fraud check speed" value={lat?.scoreP50 != null ? ms(lat.scoreP50) : '—'} sub={lat?.samples ? `typical · slowest 5% ${ms(lat.scoreP95)}` : 'no timed payments yet'} onClick={() => jump('ov-platform')} />
        <Tile ico="👥" label="Users" value={int(stats?.users)} sub={stats?.pendingUsers ? `${stats.pendingUsers} waiting for approval` : 'none waiting for approval'} tone={stats?.pendingUsers ? 'warn' : ''} onClick={() => go('users')} />
      </div>

      {/* ---- traffic ---- */}
      <Section id="ov-traffic" ico="📈" title="Traffic & decisions" sub="How many payments came in and what the fraud check decided. Hover the bars for details." />
      <div className="ov-grid a">
        <TrafficChart pipeline={pipeline} flow={flow} />
        <DecisionMix stats={stats} flow={flow} go={go} />
      </div>

      {/* ---- platform ---- */}
      <Section id="ov-platform" ico="🌊" title="Data platform" sub="Where the payment data is right now, how the last Databricks runs went, and how fast payments are scored." />
      <div className="card">
        <div className="card-title"><h3><span className="ico">🌊</span> Data flow</h3><button className="btn ghost sm" onClick={() => go('pipeline')}>Details</button></div>
        <StageMap flow={flow} compact />
      </div>
      <div className="ov-grid b">
        <div className="card">
          <div className="card-title"><h3><span className="ico">🧱</span> Recent pipeline runs</h3><span className="faint" style={{ fontSize: 12 }}>{flow?.job?.name || ''}</span></div>
          {!flow ? <div className="faint">Loading…</div> : <RunTimeline runs={flow.runs} order={['bronze', 'silver', 'gold']} host={flow.host} jobId={flow.job?.jobId} />}
        </div>
        <div className="card">
          <div className="card-title"><h3><span className="ico">⏱️</span> Scoring speed</h3><span className="faint" style={{ fontSize: 12 }}>measured on real payments</span></div>
          {!flow ? <div className="faint">Loading…</div> : <Latency lat={lat} />}
        </div>
      </div>

      {/* ---- live + model ---- */}
      <Section id="ov-live" ico="⚡" title="Live activity & model" sub="The newest payments (live over Socket.IO) and the latest model trained in Databricks." />
      <div className="ov-grid c">
        <div className="card">
          <div className="card-title"><h3><span className="ico">⚡</span> Latest payments</h3><span className="live-pill"><span className="dot pulse" /> live</span></div>
          <LiveTable recent={recent} liveFeed={liveFeed} go={go} />
        </div>
        <ModelCard training={training} fe={fe} go={go} />
      </div>
    </div>
  );
}
