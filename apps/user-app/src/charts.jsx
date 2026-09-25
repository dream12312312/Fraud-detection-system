import React, { useMemo, useState } from 'react';

const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (n) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `$${Math.round(n)}`);
const OUT_TYPES = ['TRANSFER', 'PAYMENT', 'WITHDRAWAL'];
// the fraud engine's decision boundaries (services/fraud-engine/app.py)
export const REVIEW_AT = 0.3;
export const BLOCK_AT = 0.7;

/* ---------- money in / out per day ---------- */

const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days']];

/**
 * Per-day money sent, money stopped (blocked or failed, so it never left) and
 * money received. Hover a day for its totals.
 */
export function MoneyChart({ txns }) {
  const [days, setDays] = useState(30);
  const [hover, setHover] = useState(null);
  const buckets = useMemo(() => {
    const out = [];
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - days + 1);
    for (let i = 0; i < days; i += 1) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      out.push({ d, sent: 0, stopped: 0, received: 0, n: 0 });
    }
    for (const t of txns) {
      const i = Math.floor((new Date(t.createdAt) - start) / 86400000);
      if (i < 0 || i >= days) continue;
      const b = out[i]; const a = Number(t.amount || 0);
      b.n += 1;
      if (t.type === 'DEPOSIT') b.received += a;
      else if (OUT_TYPES.includes(t.type) && t.status === 'COMPLETED') b.sent += a;
      else if (['BLOCKED', 'FAILED'].includes(t.status)) b.stopped += a;
    }
    return out;
  }, [txns, days]);
  const tot = buckets.reduce((s, b) => ({ sent: s.sent + b.sent, stopped: s.stopped + b.stopped, received: s.received + b.received, n: s.n + b.n }), { sent: 0, stopped: 0, received: 0, n: 0 });
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.sent + b.stopped, b.received)));
  const W = 640; const H = 170; const bw = W / days;
  const y = (v) => H - (v / max) * (H - 12);
  const label = (d) => d.toLocaleDateString('en-US', days > 7 ? { month: 'short', day: 'numeric' } : { weekday: 'short' });
  const tickEvery = days === 7 ? 1 : days === 30 ? 5 : 15;
  const h = hover != null ? buckets[hover] : null;

  return (
    <div className="mchart">
      <div className="mchart-head">
        <div className="mchart-tot">
          <span><i className="sw sent" />Money out <b>{money(tot.sent)}</b></span>
          <span><i className="sw stopped" />Stopped by security <b>{money(tot.stopped)}</b></span>
          <span><i className="sw received" />Money in <b>{money(tot.received)}</b></span>
        </div>
        <div className="seg">{RANGES.map(([n, l]) => <button key={n} className={days === n ? 'on' : ''} onClick={() => { setDays(n); setHover(null); }}>{l}</button>)}</div>
      </div>
      <div className="mchart-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={`Money over the last ${days} days: sent ${money(tot.sent)}, stopped ${money(tot.stopped)}, received ${money(tot.received)}`}>
          {[0.5, 1].map((f) => <line key={f} x1="0" x2={W} y1={y(max * f)} y2={y(max * f)} className="grid-l" />)}
          {buckets.map((b, i) => {
            const x = i * bw; const pad = Math.min(bw * 0.18, 6); const w = bw - pad * 2;
            return (
              <g key={i} onMouseEnter={() => setHover(i)} className={hover === i ? 'on' : ''}>
                <rect x={x} y="0" width={bw} height={H} className="hit" />
                {b.received > 0 && <rect x={x + pad} y={y(b.received)} width={w * 0.34} height={H - y(b.received)} rx="2" className="b-received" />}
                <rect x={x + pad + w * 0.38} y={y(b.sent)} width={w * 0.62} height={H - y(b.sent)} rx="2" className="b-sent" />
                {b.stopped > 0 && <rect x={x + pad + w * 0.38} y={y(b.sent + b.stopped)} width={w * 0.62} height={y(b.sent) - y(b.sent + b.stopped)} rx="2" className="b-stopped" />}
                {i % tickEvery === 0 && <text x={x + bw / 2} y={H + 14} className="tick">{label(b.d)}</text>}
              </g>
            );
          })}
          <text x="4" y={y(max) - 2} className="tick start">{short(max)}</text>
        </svg>
        {h && (
          <div className="mchart-tip" style={{ left: `${Math.min(Math.max(((hover + 0.5) / days) * 100, 12), 88)}%` }}>
            <b>{h.d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</b>
            {h.n === 0 ? <span className="faint">no activity</span> : (
              <>
                <span>Money out {money(h.sent)}</span>
                {h.stopped > 0 && <span className="neg">Stopped {money(h.stopped)}</span>}
                {h.received > 0 && <span className="pos">Money in {money(h.received)}</span>}
                <span className="faint">{h.n} transaction{h.n === 1 ? '' : 's'}</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- where the money went ---------- */

const PALETTE = ['#3b6cff', '#7c4dff', '#0ea5a4', '#f59e0b', '#ec4899', '#64748b'];

/** Completed outgoing money grouped by payee or merchant. Hover a slice or a row. */
export function WhereMoneyWent({ txns, beneficiaries }) {
  const [hover, setHover] = useState(null);
  const slices = useMemo(() => {
    const names = new Map(beneficiaries.map((b) => [String(b._id), b.nickname]));
    const by = new Map();
    for (const t of txns) {
      if (t.status !== 'COMPLETED' || !OUT_TYPES.includes(t.type)) continue;
      const k = t.merchant || names.get(String(t.beneficiaryId)) || 'Other accounts';
      const e = by.get(k) || { name: k, total: 0, n: 0 };
      e.total += Number(t.amount || 0); e.n += 1; by.set(k, e);
    }
    const all = [...by.values()].sort((a, b) => b.total - a.total);
    const top = all.slice(0, 5);
    const rest = all.slice(5);
    if (rest.length) top.push({ name: `${rest.length} others`, total: rest.reduce((s, r) => s + r.total, 0), n: rest.reduce((s, r) => s + r.n, 0) });
    return top.map((s, i) => ({ ...s, color: PALETTE[i] }));
  }, [txns, beneficiaries]);
  const total = slices.reduce((s, x) => s + x.total, 0);
  if (!total) return <p className="faint" style={{ fontSize: 13.5 }}>No completed payments yet. Once money leaves your account, this shows who it went to.</p>;

  const R = 52; const C = 2 * Math.PI * R;
  let acc = 0;
  const h = hover != null ? slices[hover] : null;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut" role="img" aria-label={slices.map((s) => `${s.name} ${money(s.total)}`).join(', ')}>
        {slices.map((s, i) => {
          const len = (s.total / total) * C;
          const el = <circle key={s.name} cx="70" cy="70" r={R} fill="none" stroke={s.color} strokeWidth={hover === i ? 22 : 17} strokeDasharray={`${Math.max(len - 1.5, 0.5)} ${C}`} strokeDashoffset={-acc} transform="rotate(-90 70 70)" opacity={hover == null || hover === i ? 1 : 0.35} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer', transition: 'stroke-width .15s, opacity .15s' }} />;
          acc += len;
          return el;
        })}
        <text x="70" y="66" className="donut-v">{h ? `${Math.round((h.total / total) * 100)}%` : short(total)}</text>
        <text x="70" y="84" className="donut-l">{h ? h.name.slice(0, 16) : 'sent in total'}</text>
      </svg>
      <ul className="donut-legend">
        {slices.map((s, i) => (
          <li key={s.name} className={hover === i ? 'on' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <i style={{ background: s.color }} /><span className="nm">{s.name}</span><span className="faint">{s.n}×</span><b>{money(s.total)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- risk gauge ---------- */

/** The payment's risk score on the engine's three zones: approve, confirm, block. */
export function RiskGauge({ prob }) {
  if (prob == null) return null;
  const p = Math.min(Math.max(prob, 0), 1);
  const pt = (v, r) => { const a = Math.PI * (1 - v); return [100 + r * Math.cos(a), 100 - r * Math.sin(a)]; };
  const arc = (a, b) => { const [x1, y1] = pt(a, 80); const [x2, y2] = pt(b, 80); return `M${x1} ${y1} A80 80 0 0 1 ${x2} ${y2}`; };
  const [nx, ny] = pt(p, 66);
  const zone = p >= BLOCK_AT ? 'block' : p >= REVIEW_AT ? 'review' : 'approve';
  return (
    <div className="gauge">
      <svg viewBox="0 0 200 118" role="img" aria-label={`Risk score ${Math.round(p * 100)} percent: ${zone}`}>
        <path d={arc(0, REVIEW_AT)} className="gz approve" />
        <path d={arc(REVIEW_AT, BLOCK_AT)} className="gz review" />
        <path d={arc(BLOCK_AT, 1)} className="gz block" />
        <line x1="100" y1="100" x2={nx} y2={ny} className="g-needle" />
        <circle cx="100" cy="100" r="6" className="g-hub" />
        <text x="100" y="86" className={`g-v ${zone}`}>{Math.round(p * 100)}%</text>
      </svg>
      <div className="gauge-keys">
        <span className={zone === 'approve' ? 'on approve' : ''}>under 30% · approved</span>
        <span className={zone === 'review' ? 'on review' : ''}>30–70% · you confirm</span>
        <span className={zone === 'block' ? 'on block' : ''}>70%+ · blocked</span>
      </div>
    </div>
  );
}

/* ---------- risk map ---------- */

const STATUS_COLOR = { COMPLETED: 'var(--success)', CHALLENGED: 'var(--warn)', BLOCKED: 'var(--danger)', FAILED: 'var(--text-faint)', PENDING_RISK_CHECK: 'var(--info)' };

/**
 * Every scored payment as a dot: when (x), the fraud engine's risk score (y),
 * outcome (colour) and amount (size). Click a dot to open that payment.
 */
export function RiskMap({ txns, selected, onPick }) {
  const [hover, setHover] = useState(null);
  const pts = txns.filter((t) => t.fraudProbability != null);
  if (pts.length < 2) return null;
  const times = pts.map((t) => new Date(t.createdAt).getTime());
  const t0 = Math.min(...times); const t1 = Math.max(...times); const span = Math.max(t1 - t0, 60000);
  const maxAmt = Math.max(...pts.map((t) => Number(t.amount || 0)), 1);
  const W = 800; const H = 200; const L = 34; const B = 20;
  const x = (t) => L + 8 + ((new Date(t.createdAt).getTime() - t0) / span) * (W - L - 16);
  const y = (p) => 6 + (1 - p) * (H - B - 6);
  const r = (a) => 4 + Math.sqrt(Number(a || 0) / maxAmt) * 10;
  const h = pts.find((t) => t._id === hover);
  const fmt = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div className="rmap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Risk map of ${pts.length} payments`}>
        <rect x={L} y={y(1)} width={W - L} height={y(BLOCK_AT) - y(1)} className="band block" />
        <rect x={L} y={y(BLOCK_AT)} width={W - L} height={y(REVIEW_AT) - y(BLOCK_AT)} className="band review" />
        <rect x={L} y={y(REVIEW_AT)} width={W - L} height={y(0) - y(REVIEW_AT)} className="band approve" />
        {[0, REVIEW_AT, BLOCK_AT, 1].map((v) => <text key={v} x={L - 5} y={y(v) + 4} className="tick end">{Math.round(v * 100)}%</text>)}
        <text x={W - 6} y={y(1) + 14} className="band-l end">blocked</text>
        <text x={W - 6} y={y(BLOCK_AT) + 14} className="band-l end">you confirm</text>
        <text x={W - 6} y={H - 6} className="band-l end">approved</text>
        <text x={L + 4} y={H - 4} className="tick start">{fmt(t0)}</text>
        <text x={W - 6} y={H - 4} className="tick end">{fmt(t1)}</text>
        {pts.map((t) => (
          <circle key={t._id} cx={x(t)} cy={y(t.fraudProbability)} r={r(t.amount)} fill={STATUS_COLOR[t.status] || 'var(--info)'}
            className={`dot ${selected === t._id ? 'sel' : ''} ${hover === t._id ? 'hov' : ''}`}
            onMouseEnter={() => setHover(t._id)} onMouseLeave={() => setHover(null)} onClick={() => onPick(t._id)}>
            <title>{`${t.txId}: ${money(t.amount)}, risk ${Math.round(t.fraudProbability * 100)}%, ${t.status}`}</title>
          </circle>
        ))}
      </svg>
      <div className="rmap-foot">
        {h
          ? <span><b>{money(h.amount)}</b> · {new Date(h.createdAt).toLocaleString()} · risk <b>{Math.round(h.fraudProbability * 100)}%</b> · <span className={`badge ${h.status}`}>{h.status}</span></span>
          : <span className="faint">Each dot is one payment: height = risk score, size = amount, colour = outcome. Click a dot to open it.</span>}
      </div>
    </div>
  );
}

/* ---------- signals preview ---------- */

/**
 * What the fraud engine will be given for the payment being typed, from the
 * server's own computation (GET /transfer/signals). The score is not shown.
 */
export function SignalPreview({ s }) {
  if (!s) return null;
  const ratio = s.amount && s.avgAmount30d ? s.amount / s.avgAmount30d : 0;
  const scale = Math.max(12, ratio * 1.1);
  const night = s.hourOfDay < 6;
  const level = (bad, warn) => (bad ? 'bad' : warn ? 'warn' : 'ok');
  const rows = [
    { k: 'Amount vs your usual', lvl: level(ratio > 10, ratio > 4),
      v: s.amount ? `${ratio.toFixed(1)}× your 30-day average (${money(s.avgAmount30d)})` : 'enter an amount',
      bar: s.amount ? (
        <div className="sig-bar">
          <span className="fill" style={{ width: `${Math.min((ratio / scale) * 100, 100)}%` }} />
          <span className="mark" style={{ left: `${(4 / scale) * 100}%` }} title="4× — noticeably higher" />
          <span className="mark hi" style={{ left: `${(10 / scale) * 100}%` }} title="10× — much higher" />
        </div>
      ) : null },
    { k: 'Payee', lvl: s.isNewBeneficiary ? 'warn' : 'ok', v: s.isNewBeneficiary ? 'not in your saved payees' : 'saved payee' },
    { k: 'Country', lvl: s.isForeign ? 'warn' : 'ok', v: s.isForeign ? `outside your home country (${s.homeCountry})` : `your home country (${s.homeCountry})` },
    { k: 'Pace', lvl: level(false, s.velocity1h >= 5), v: `${s.velocity1h} payment${s.velocity1h === 1 ? '' : 's'} in the last hour, including this one` },
    { k: 'Time', lvl: night && s.amount > 1000 ? 'warn' : 'ok', v: `${String(s.hourOfDay).padStart(2, '0')}:00 UTC · ${night ? 'night' : 'daytime'}` }
  ];
  return (
    <ul className="sigs">
      {rows.map((r) => (
        <li key={r.k} className={r.lvl}>
          <span className="sig-dot" />
          <div><div className="sig-k">{r.k}</div><div className="sig-v">{r.v}</div>{r.bar}</div>
        </li>
      ))}
    </ul>
  );
}
