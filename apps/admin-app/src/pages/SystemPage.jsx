import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { PageHead, int, timeAgo } from '../ui.jsx';
import '../system.css';

/**
 * System health — every number here comes from a real check:
 * - API round trip is timed in this browser;
 * - MongoDB / interactions DB pings and the fraud engine's /health are timed
 *   by the API on each request (GET /admin/system);
 * - Databricks resources come from GET /admin/databricks/status.
 * The history strips only cover checks made since this page was opened.
 */

const SYS_EVERY = 10000;
const DBX_EVERY = 30000;
const KEEP = 30;

function usePoll(path, every) {
  const [s, setS] = useState({ data: null, error: null, ms: null, at: null, n: 0 });
  const alive = useRef(true);
  const run = useCallback(async () => {
    const t0 = performance.now();
    try {
      const data = await api(path);
      if (alive.current) setS((p) => ({ data, error: null, ms: Math.round(performance.now() - t0), at: Date.now(), n: p.n + 1 }));
    } catch (e) {
      if (alive.current) setS((p) => ({ ...p, error: e?.message || 'failed', ms: null, at: Date.now(), n: p.n + 1 }));
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    run();
    const t = setInterval(run, every);
    return () => { alive.current = false; clearInterval(t); };
  }, [run, every]);
  return [s, run];
}

const upFmt = (sec) => {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${sec % 60}s` : `${sec}s`;
};
const msFmt = (ms) => (ms == null ? '—' : ms < 10 ? ms.toFixed(1) : String(Math.round(ms)));
const STATE_LABEL = { ok: 'Healthy', warn: 'Needs attention', error: 'Down', idle: 'Off / unknown' };

function Sparkline({ points }) {
  const vals = points.map((p) => p.ms).filter((v) => v != null);
  if (vals.length < 2) return <div className="sh-spark-empty">{vals.length ? 'collecting…' : 'no timing'}</div>;
  const max = Math.max(...vals) * 1.15 || 1;
  const W = 120, H = 34, step = W / Math.max(1, points.length - 1);
  const xy = points.map((p, i) => (p.ms == null ? null : [i * step, H - (p.ms / max) * (H - 4) - 2]));
  const line = xy.filter(Boolean).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const first = xy.find(Boolean), last = [...xy].reverse().find(Boolean);
  return (
    <svg className="sh-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`${first[0]},${H} ${line} ${last[0]},${H}`} className="sh-spark-fill" />
      <polyline points={line} className="sh-spark-line" />
      <circle cx={last[0]} cy={last[1]} r="2.6" className="sh-spark-dot" />
    </svg>
  );
}

function Uptime({ points, label = 'check' }) {
  // "up" = answering, even if degraded (warn); only "error" counts as down.
  const counted = points.filter((p) => p.s !== 'idle').length;
  const ok = points.filter((p) => p.s === 'ok' || p.s === 'warn').length;
  return (
    <div className="sh-up">
      <div className="sh-up-ticks">
        {Array.from({ length: KEEP - points.length }, (_, i) => <i key={`e${i}`} className="sh-pad" />)}
        {points.map((p, i) => <i key={i} className={p.s} title={`${new Date(p.t).toLocaleTimeString()} · ${STATE_LABEL[p.s]}${p.ms != null ? ` · ${msFmt(p.ms)} ms` : ''}`} />)}
      </div>
      <div className="sh-up-txt">
        {counted ? <><b>{Math.round((ok / counted) * 100)}%</b> up over {counted} {label}{counted > 1 ? 's' : ''} this session</> : points.length ? 'switched off — not counted' : 'waiting for the first check…'}
      </div>
    </div>
  );
}

function ServiceCard({ svc, hist, selected, onSelect, go }) {
  const ref = useRef(null);
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [selected]);
  return (
    <div ref={ref} className={`sh-card ${svc.state} ${selected ? 'sel' : ''}`} onClick={() => onSelect(svc.key)}>
      <div className="sh-card-top">
        <span className="sh-ico">{svc.ico}</span>
        <div className="sh-card-name"><b>{svc.name}</b><span>{svc.sub}</span></div>
        <span className={`sh-pill ${svc.state}`}><i />{STATE_LABEL[svc.state]}</span>
      </div>
      <div className="sh-card-head">{svc.headline}</div>
      <div className="sh-lat">
        <div className="sh-lat-num">
          <b>{msFmt(svc.ms)}</b><span>ms</span>
          <em>{svc.msLabel}</em>
        </div>
        <Sparkline points={hist} />
      </div>
      <Uptime points={hist} label={svc.key === 'databricks' || svc.key === 'warehouse' ? 'probe' : 'check'} />
      {svc.meter && (
        <div className="sh-meter" title={svc.meter.title}>
          <div className="sh-meter-l"><span>{svc.meter.label}</span><b>{svc.meter.text}</b></div>
          <div className="sh-meter-bar"><i style={{ width: `${Math.min(100, svc.meter.pct)}%` }} /></div>
        </div>
      )}
      <div className="sh-rows">
        {svc.rows.map(([k, v]) => <div key={k}><span>{k}</span><b title={typeof v === 'string' ? v : undefined}>{v}</b></div>)}
      </div>
      {svc.go && <button className="sh-go" onClick={(e) => { e.stopPropagation(); go?.(svc.go); }}>Open {svc.goLabel} →</button>}
    </div>
  );
}

/* ---- topology ---- */
const NODE_W = 170, NODE_H = 52;
const POS = {
  browser: [95, 215], api: [345, 215],
  mongo: [620, 90], ixdb: [620, 175], engine: [620, 260], kafka: [620, 345],
  databricks: [880, 175], warehouse: [880, 300]
};
const side = (k, dir) => [POS[k][0] + (dir * NODE_W) / 2, POS[k][1]];
const curve = ([x1, y1], [x2, y2]) => { const mx = (x1 + x2) / 2; return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`; };
const EDGES = [
  ['browser', 'api', curve(side('browser', 1), side('api', -1))],
  ...['mongo', 'ixdb', 'engine', 'kafka'].map((k) => ['api', k, curve(side('api', 1), side(k, -1))]),
  ['api', 'databricks', `M${POS.api[0]},${POS.api[1] - NODE_H / 2} C${POS.api[0]},0 ${POS.databricks[0]},0 ${POS.databricks[0]},${POS.databricks[1] - NODE_H / 2}`],
  ['kafka', 'databricks', curve(side('kafka', 1), side('databricks', -1))],
  ['databricks', 'warehouse', `M${POS.databricks[0]},${POS.databricks[1] + NODE_H / 2} L${POS.warehouse[0]},${POS.warehouse[1] - NODE_H / 2}`]
];

function Topology({ nodes, selected, onSelect, motion }) {
  const by = Object.fromEntries(nodes.map((n) => [n.key, n]));
  const edgeState = (a, b) => {
    const s = [by[a]?.state, by[b]?.state];
    if (s.includes('error')) return 'error';
    if (s.includes('idle')) return 'idle';
    if (s.includes('warn')) return 'warn';
    return 'ok';
  };
  return (
    <div className="sh-topo-wrap">
      <svg className="sh-topo" viewBox="0 0 1000 380" role="img" aria-label="Service map: which services the API talks to and whether each link is healthy">
        {EDGES.map(([a, b, d]) => {
          const st = edgeState(a, b);
          const hot = selected && (selected === a || selected === b);
          return (
            <g key={`${a}-${b}`} className={`sh-edge ${st} ${hot ? 'hot' : ''}`}>
              <path d={d} className="sh-edge-base" />
              <path d={d} className="sh-edge-flow" />
              {motion && st === 'ok' && (
                <circle r="3.6" className="sh-packet"><animateMotion dur={`${2 + (a.length + b.length) % 3 * 0.4}s`} repeatCount="indefinite" path={d} /></circle>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const [x, y] = POS[n.key];
          return (
            <g key={n.key} className={`sh-node ${n.state} ${selected === n.key ? 'sel' : ''}`} transform={`translate(${x - NODE_W / 2},${y - NODE_H / 2})`}
              onClick={() => n.key !== 'browser' && onSelect(n.key)} tabIndex={n.key === 'browser' ? -1 : 0}
              onKeyDown={(e) => { if (e.key === 'Enter' && n.key !== 'browser') onSelect(n.key); }}>
              {n.state !== 'idle' && <rect className="sh-node-halo" x="-4" y="-4" width={NODE_W + 8} height={NODE_H + 8} rx="16" />}
              <rect className="sh-node-box" width={NODE_W} height={NODE_H} rx="13" />
              <text x="14" y="33" className="sh-node-ico">{n.ico}</text>
              <text x="44" y="23" className="sh-node-name">{n.name}</text>
              <text x="44" y="39" className="sh-node-sub">{n.topo}</text>
              <circle cx={NODE_W - 13} cy="13" r="4.5" className="sh-node-dot" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function SystemPage({ go, liveFeed = [] }) {
  const [sys, reloadSys] = usePoll('/admin/system', SYS_EVERY);
  const [dbx, reloadDbx] = usePoll('/admin/databricks/status', DBX_EVERY);
  const [hist, setHist] = useState({});
  const [sel, setSel] = useState(null);
  const [checking, setChecking] = useState(false);
  const [, tick] = useState(0);
  const motion = useMemo(() => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, []);

  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const S = sys.data, D = dbx.data;
  const apiDown = Boolean(sys.error);
  const fe = S?.fraudEngine ?? {};
  const ix = S?.interactions ?? {};
  const wh = D?.checks?.find((c) => c.key === 'warehouse');
  const lastPush = liveFeed[0]?._at;
  const unknownIfDown = (state) => (apiDown ? 'idle' : state);

  const services = [
    {
      key: 'api', ico: '🟢', name: 'Node.js API', sub: 'Express · Socket.IO · :4000',
      state: apiDown ? 'error' : S ? 'ok' : 'idle', headline: apiDown ? `Unreachable — ${sys.error}` : S ? 'Online and answering' : 'Checking…',
      ms: sys.ms, msLabel: 'round trip from this browser', topo: apiDown ? 'unreachable' : sys.ms != null ? `${sys.ms} ms` : '…',
      meter: S?.api && { label: 'Heap in use', text: `${S.api.heapUsedMb} / ${S.api.heapTotalMb} MB`, pct: (S.api.heapUsedMb / Math.max(1, S.api.heapTotalMb)) * 100, title: `Process RSS ${S.api.rssMb} MB` },
      rows: [['Process uptime', upFmt(S?.api?.uptimeSec)], ['Node.js', S?.api?.node || '—'], ['Last live push', lastPush ? timeAgo(lastPush) : 'none since page load']]
    },
    {
      key: 'mongo', ico: '🗄️', name: 'MongoDB', sub: 'accounts, payments, users',
      state: unknownIfDown(S ? (S.mongo?.connected ? 'ok' : 'error') : 'idle'),
      headline: apiDown ? 'Unknown — API unreachable' : !S ? 'Checking…' : S.mongo?.connected ? 'Connected' : 'Disconnected',
      ms: apiDown ? null : S?.mongo?.latencyMs, msLabel: 'ping, timed by the API', topo: S?.mongo?.latencyMs != null && !apiDown ? `${msFmt(S.mongo.latencyMs)} ms ping` : '—',
      rows: [['Users', int(S?.counts?.users)], ['Transactions', int(S?.counts?.totalTx)], ['Fraud alerts', int(S?.counts?.fraudAlerts)]], go: 'transactions', goLabel: 'transactions'
    },
    {
      key: 'ixdb', ico: '🗃️', name: 'Interactions DB', sub: ix.database || 'sentinelpay_interactions',
      state: unknownIfDown(S ? (ix.connected ? (ix.dropped ? 'warn' : 'ok') : 'error') : 'idle'),
      headline: apiDown ? 'Unknown — API unreachable' : !S ? 'Checking…' : !ix.connected ? `Disconnected${ix.lastError ? ` — ${ix.lastError}` : ''}` : ix.dropped ? `Connected · ${int(ix.dropped)} events dropped since start` : 'Connected · recording events',
      ms: apiDown ? null : ix.latencyMs, msLabel: 'ping, timed by the API', topo: ix.latencyMs != null && !apiDown ? `${msFmt(ix.latencyMs)} ms ping` : '—',
      rows: [['Written since API start', int(ix.written)], ['Dropped since API start', int(ix.dropped)]], go: 'interactions', goLabel: 'interactions'
    },
    {
      key: 'engine', ico: '🧠', name: 'Fraud engine', sub: fe.url || 'FastAPI :8000',
      state: unknownIfDown(!S ? 'idle' : !fe.reachable ? 'error' : fe.modelLoaded ? 'ok' : 'warn'),
      headline: apiDown ? 'Unknown — API unreachable' : !S ? 'Checking…' : !fe.reachable ? 'Offline → API uses fallback rules' : fe.modelLoaded ? 'ML model active' : 'Running on base rules (no ML model loaded)',
      ms: apiDown ? null : fe.latencyMs, msLabel: '/health, timed by the API', topo: fe.reachable && !apiDown ? `${fe.mode === 'ML_MODEL' ? 'ML' : 'rules'} · ${msFmt(fe.latencyMs)} ms` : 'offline',
      rows: [['Mode', fe.mode || '—'], ['Features', fe.features ?? '—']], go: 'training', goLabel: 'model training'
    },
    {
      key: 'kafka', ico: '🔥', name: 'Kafka', sub: 'event backbone (optional)',
      state: unknownIfDown(S ? (S.kafka?.enabled ? 'ok' : 'idle') : 'idle'),
      headline: apiDown ? 'Unknown — API unreachable' : !S ? 'Checking…' : S.kafka?.enabled ? 'Enabled in config (brokers not pinged)' : 'Off — KAFKA_ENABLED=false',
      ms: null, msLabel: 'not probed', topo: S?.kafka?.enabled ? 'enabled' : 'off',
      rows: [['Brokers', (S?.kafka?.brokers || []).join(', ') || '—'], ['Lakehouse path', S?.kafka?.enabled ? 'Kafka → bridge → volume' : 'API landing export']]
    },
    {
      key: 'databricks', ico: '🧱', name: 'Databricks', sub: D?.host?.replace(/^https?:\/\//, '') || 'workspace',
      state: !D ? (dbx.error ? 'error' : 'idle') : !D.configured ? 'error' : D.ready ? 'ok' : 'warn',
      headline: dbx.error ? `Status check failed — ${dbx.error}` : !D ? 'Checking… (can take a few seconds)' : !D.configured ? 'Not configured' : D.ready ? 'Workspace ready' : 'Connected · set-up incomplete',
      ms: dbx.ms, msLabel: 'full status probe, all resources', topo: D?.checks ? `${D.checks.filter((c) => c.state === 'ok').length}/${D.checks.length} ready` : '…',
      rows: [['Catalog', D?.catalog || '—'], ['Token owner', D?.user || '—']], go: 'databricks', goLabel: 'Databricks'
    },
    {
      key: 'warehouse', ico: '🧮', name: 'SQL warehouse', sub: 'row counts, DDL fallback',
      state: !wh ? (D && !D.configured ? 'error' : 'idle') : wh.state === 'ok' ? 'ok' : wh.state === 'missing' ? 'warn' : 'error',
      headline: wh?.detail || (D && !D.configured ? 'Databricks not configured' : 'Checking…'),
      ms: null, msLabel: 'checked inside the Databricks probe', topo: wh?.detail?.split(' · ')[1]?.split(' ')[0] || (wh ? wh.state : '…'),
      rows: [['Used for', 'Bronze/Silver/Gold row counts']]
    }
  ];

  // Append one sample per service each time a check completes.
  useEffect(() => {
    if (!sys.n) return;
    setHist((h) => {
      const next = { ...h };
      for (const s of services.filter((x) => !['databricks', 'warehouse'].includes(x.key))) next[s.key] = [...(h[s.key] || []), { s: s.state, ms: s.ms ?? null, t: sys.at }].slice(-KEEP);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sys.n]);
  useEffect(() => {
    if (!dbx.n) return;
    setHist((h) => {
      const next = { ...h };
      for (const s of services.filter((x) => ['databricks', 'warehouse'].includes(x.key))) next[s.key] = [...(h[s.key] || []), { s: s.state, ms: s.ms ?? null, t: dbx.at }].slice(-KEEP);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbx.n]);

  const counted = services.filter((s) => s.state !== 'idle');
  const healthy = counted.filter((s) => s.state === 'ok').length;
  const down = services.filter((s) => s.state === 'error');
  const warn = services.filter((s) => s.state === 'warn');
  const off = services.filter((s) => s.state === 'idle');
  const tone = down.length ? 'error' : warn.length ? 'warn' : 'ok';
  const headline = !sys.n ? 'Running first check…' : down.length ? `${down.length} service${down.length > 1 ? 's' : ''} down` : warn.length ? `Up · ${warn.length} need${warn.length > 1 ? '' : 's'} attention` : 'All systems operational';
  const ring = 2 * Math.PI * 42;
  const frac = counted.length ? healthy / counted.length : 0;
  const nextIn = sys.at ? Math.max(0, Math.ceil((sys.at + SYS_EVERY - Date.now()) / 1000)) : null;

  const checkNow = async () => { setChecking(true); await Promise.all([reloadSys(), reloadDbx()]); setChecking(false); };
  const nodes = [{ key: 'browser', ico: '🖥️', name: 'Admin console', topo: 'this browser', state: 'ok' }, ...services];
  const selSvc = services.find((s) => s.key === sel);

  return (
    <div className="sh">
      <PageHead title="System health" sub="Every service the platform depends on, checked live. Timings are real round trips measured on each check.">
        <button className="btn" onClick={checkNow} disabled={checking}>{checking ? 'Checking…' : '↻ Check now'}</button>
      </PageHead>

      {/* ---- hero ---- */}
      <section className={`sh-hero ${tone}`}>
        <div className="sh-ring">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="42" className="sh-ring-bg" />
            <circle cx="50" cy="50" r="42" className="sh-ring-fg" strokeDasharray={`${ring * frac} ${ring}`} />
          </svg>
          <div className="sh-ring-c"><b>{healthy}/{counted.length || '—'}</b><span>healthy</span></div>
        </div>
        <div className="sh-hero-main">
          <div className="sh-kicker"><span className="sh-pulse" />Live · API checked every {SYS_EVERY / 1000}s, Databricks every {DBX_EVERY / 1000}s</div>
          <div className="sh-hero-h">{headline}</div>
          <div className="sh-chips">
            {down.map((s) => <button key={s.key} className="sh-chip error" onClick={() => setSel(s.key)}>{s.ico} {s.name} down</button>)}
            {warn.map((s) => <button key={s.key} className="sh-chip warn" onClick={() => setSel(s.key)}>{s.ico} {s.name}</button>)}
            {off.map((s) => <button key={s.key} className="sh-chip idle" onClick={() => setSel(s.key)}>{s.ico} {s.name} off</button>)}
            {!down.length && !warn.length && sys.n > 0 && <span className="sh-chip ok">✓ no incidents in this check</span>}
          </div>
          <div className="sh-next">
            <span>{sys.at ? `Last check ${timeAgo(new Date(sys.at).toISOString())}` : 'First check running'}{nextIn != null ? ` · next in ${nextIn}s` : ''}</span>
            <div className="sh-next-bar"><i key={sys.n} style={{ animationDuration: `${SYS_EVERY}ms` }} /></div>
          </div>
        </div>
        <div className="sh-hero-stats">
          <div><b>{sys.ms != null ? `${sys.ms} ms` : '—'}</b><span>API round trip</span></div>
          <div><b>{upFmt(S?.api?.uptimeSec)}</b><span>API uptime</span></div>
          <div><b>{int(S?.counts?.totalTx)}</b><span>payments stored</span></div>
          <div><b>{int(S?.counts?.challengedTx)}</b><span>awaiting customer</span></div>
        </div>
      </section>

      {/* ---- topology ---- */}
      <section className="card sh-map">
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>Service map</h3>
            <div className="faint" style={{ fontSize: 12.5 }}>Moving dots = a healthy link. Red dashes = broken. Grey = switched off. Click a service to jump to its card.</div>
          </div>
          <div className="sh-legend"><span><i className="ok" />healthy</span><span><i className="warn" />attention</span><span><i className="error" />down</span><span><i className="idle" />off</span></div>
        </div>
        <Topology nodes={nodes} selected={sel} onSelect={setSel} motion={motion} />
        {selSvc && (
          <div className={`sh-focus ${selSvc.state}`}>
            <span className="sh-ico">{selSvc.ico}</span>
            <div><b>{selSvc.name}</b> — {selSvc.headline}</div>
            <button className="sh-x" onClick={() => setSel(null)} aria-label="Clear selection">✕</button>
          </div>
        )}
      </section>

      {/* ---- service cards ---- */}
      <div className="sh-grid">
        {services.map((s) => <ServiceCard key={s.key} svc={s} hist={hist[s.key] || []} selected={sel === s.key} onSelect={setSel} go={go} />)}
      </div>

      {/* ---- databricks resources ---- */}
      {D?.checks?.length > 0 && (
        <section className="card sh-dbx">
          <div className="row between"><h3 style={{ margin: 0 }}>🧱 Databricks resources</h3><span className="faint" style={{ fontSize: 12.5 }}>{D.checks.filter((c) => c.state === 'ok').length} of {D.checks.length} ready · probed {timeAgo(new Date(dbx.at).toISOString())}</span></div>
          <div className="sh-dbx-bar">{D.checks.map((c) => <i key={c.key} className={c.state === 'ok' ? 'ok' : c.state === 'missing' ? 'warn' : 'error'} title={c.label} />)}</div>
          <div className="sh-dbx-list">
            {D.checks.map((c) => {
              const st = c.state === 'ok' ? 'ok' : c.state === 'missing' ? 'warn' : 'error';
              const body = <><span className={`sh-dbx-ico ${st}`}>{st === 'ok' ? '✓' : st === 'warn' ? '!' : '✕'}</span><div><b>{c.label}</b><span>{c.detail}</span></div>{c.url && <em>↗</em>}</>;
              return c.url
                ? <a key={c.key} className={`sh-dbx-item ${st}`} href={c.url} target="_blank" rel="noreferrer">{body}</a>
                : <div key={c.key} className={`sh-dbx-item ${st}`}>{body}</div>;
            })}
          </div>
        </section>
      )}
    </div>
  );
}
