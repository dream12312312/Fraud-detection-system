import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAdminData, useAction, PageHead, Empty, RiskBadge, Drawer, KV, Tabs, money, timeAgo, int } from '../ui.jsx';
import { Throughput, ms } from '../flow.jsx';

const SOURCES = [['HEURISTIC', 'base model (rules)', '#3b6cff'], ['ML_MODEL', 'ML model', '#8b5cf6'], ['RULES_FALLBACK', 'fallback rules (engine offline)', '#f59e0b'], ['NONE', 'never scored (stuck)', '#ef4444']];

/** Hot path: throughput, measured latency and who made the decisions. */
function ProcessingMonitor({ hot, onFilter }) {
  if (!hot) return null;
  const l = hot.latency;
  const srcTotal = SOURCES.reduce((a, [k]) => a + (hot.sources24h[k] || 0), 0) || 1;
  return (
    <div className="grid cols-2" style={{ marginBottom: 18 }}>
      <div className="card">
        <div className="card-title"><h3><span className="ico">⚡</span> Payments per minute</h3><span className="faint" style={{ fontSize: 12 }}>{int(hot.lastHour)} in the last hour</span></div>
        <Throughput perMinute={hot.perMinute} />
      </div>
      <div className="card">
        <div className="card-title"><h3><span className="ico">⏱️</span> Scoring speed</h3><span className="faint" style={{ fontSize: 12 }}>{l.samples ? `last ${l.samples} payments` : ''}</span></div>
        {l.samples ? (
          <div className="lat-row">
            <div className="lat" title="Round trip API → fraud engine → API"><b>{ms(l.scoreP50)}</b><span>fraud engine · median</span></div>
            <div className="lat"><b>{ms(l.scoreP95)}</b><span>fraud engine · p95</span></div>
            <div className="lat" title="Request received → decision saved and pushed"><b>{ms(l.totalP50)}</b><span>whole payment · median</span></div>
            <div className="lat"><b>{ms(l.totalP95)}</b><span>whole payment · p95</span></div>
          </div>
        ) : <div className="faint" style={{ fontSize: 13 }}>No measurements yet. Timings are recorded for every new payment.</div>}
        <div className="section-label">Who decided (24h)</div>
        <div className="src-bar">{SOURCES.map(([k, , c]) => hot.sources24h[k] ? <i key={k} style={{ width: `${(hot.sources24h[k] / srcTotal) * 100}%`, background: c }} title={`${hot.sources24h[k]}`} /> : null)}</div>
        <div className="g-legend">{SOURCES.map(([k, label, c]) => hot.sources24h[k] ? <span key={k}><i style={{ background: c }} />{label} · {hot.sources24h[k]}</span> : null)}</div>
        {(hot.stuck > 0 || hot.awaitingCustomer > 0) && (
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {hot.stuck > 0 && <button className="btn sm danger" onClick={() => onFilter('PENDING_RISK_CHECK')}>{hot.stuck} stuck before scoring</button>}
            {hot.awaitingCustomer > 0 && <button className="btn sm ghost" onClick={() => onFilter('CHALLENGED')}>{hot.awaitingCustomer} waiting for the customer</button>}
          </div>
        )}
      </div>
    </div>
  );
}

const reasonText = (r) => (r || []).join(', ').replaceAll('_', ' ').toLowerCase();

/** The path one transaction took through the platform, from real fields on the record. */
export function TxJourney({ tx }) {
  const adminEntry = tx.decisionSource === 'ADMIN';
  const f = tx.features || {};
  const steps = adminEntry ? [
    { t: 'Ledger entry by admin', d: tx.adminNote || 'manual adjustment', ok: true },
    { t: 'Recorded in MongoDB', d: `status ${tx.status}`, ok: true },
    { t: 'Landed in lakehouse', d: tx.lakeLandedAt ? timeAgo(tx.lakeLandedAt) : 'not yet', ok: Boolean(tx.lakeLandedAt) }
  ] : [
    { t: 'Received by API', d: `${new Date(tx.createdAt).toLocaleString()} · hold placed`, ok: true },
    { t: 'Features computed', d: tx.features ? `velocity 1h ${f.velocity1h} · 30d avg ${money(f.avgAmount30d)} · ${f.isNewBeneficiary ? 'new payee' : 'known payee'} · ${tx.country !== f.homeCountry ? 'foreign' : 'domestic'}` : 'not recorded (older transaction)', ok: Boolean(tx.features) },
    { t: `Scored by ${tx.decisionSource === 'ML_MODEL' ? 'ML model' : tx.decisionSource === 'HEURISTIC' ? 'base model (rules)' : tx.decisionSource === 'RULES_FALLBACK' ? 'fallback rules (engine offline)' : '—'}`, d: tx.fraudProbability != null ? `risk ${Math.round(tx.fraudProbability * 100)}% · ${tx.modelVersion || ''}` : 'not scored', ok: tx.fraudProbability != null },
    { t: `Decision: ${tx.decision || '—'}`, d: reasonText(tx.reasons) || 'no risk signals', ok: Boolean(tx.decision), warn: tx.decision === 'REVIEW', bad: tx.decision === 'BLOCK' },
    { t: `Ledger: ${tx.status}`, d: tx.adminNote || (tx.status === 'CHALLENGED' ? 'waiting for the customer to confirm' : tx.status === 'PENDING_RISK_CHECK' ? 'stuck before scoring — resolve manually' : ''), ok: ['COMPLETED', 'BLOCKED'].includes(tx.status), warn: ['CHALLENGED', 'PENDING_RISK_CHECK'].includes(tx.status) },
    { t: 'Landed in lakehouse', d: tx.lakeLandedAt ? `${timeAgo(tx.lakeLandedAt)} → Bronze on next pipeline run` : 'waiting for the next landing', ok: Boolean(tx.lakeLandedAt) }
  ];
  return (
    <ol className="journey">
      {steps.map((s, i) => (
        <li key={i} className={s.bad ? 'bad' : s.warn ? 'warn' : s.ok ? 'ok' : 'todo'}>
          <div className="j-t">{s.t}</div>
          {s.d && <div className="j-d">{s.d}</div>}
        </li>
      ))}
    </ol>
  );
}

export function TxDetail({ tx, onClose, onChanged, flash }) {
  const [busy, run] = useAction(flash);
  const waiting = ['CHALLENGED', 'PENDING_RISK_CHECK'].includes(tx.status);
  const resolve = (action) => run(action, () => api(`/admin/transactions/${tx.txId}/resolve`, { method: 'POST', body: { action } }),
    `Transaction ${tx.txId} ${action === 'approve' ? 'approved' : 'blocked'}.`).then((r) => { if (r) { onChanged(); onClose(); } });
  return (
    <Drawer title={`${tx.txId}`} sub={`${money(tx.amount)} · ${tx.type} · ${tx.userId?.email || ''}`} onClose={onClose}>
      <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <span className={`badge ${tx.status}`}>{tx.status}</span>
        {tx.decision && <span className={`badge ${tx.decision}`}>{tx.decision}</span>}
        <RiskBadge p={tx.fraudProbability} />
      </div>
      {waiting && (
        <div className="flash warn"><span>⚠️</span><div style={{ flex: 1 }}>
          {tx.status === 'CHALLENGED'
            ? <><b>Waiting for the customer</b>The customer has been asked to confirm or report this payment in their app. Override only if they cannot (for example, a support call). Approve moves the money; block releases the hold.</>
            : <><b>Stuck before scoring</b>The fraud engine never answered, so no one else can settle this payment. Approve moves the money; block releases the hold.</>}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn success sm" disabled={!!busy} onClick={() => resolve('approve')}>Approve payment</button>
            <button className="btn danger sm" disabled={!!busy} onClick={() => resolve('block')}>Block payment</button>
          </div>
        </div></div>
      )}
      <div className="section-label" style={{ marginTop: 4 }}>Processing path</div>
      <TxJourney tx={tx} />
      <div className="section-label">Record</div>
      <KV rows={[
        ['Customer', tx.userId?.fullName || tx.userId?.email || String(tx.userId || '—')],
        ['Merchant / reference', tx.merchant || 'transfer'],
        ['Country', tx.country],
        ['Model version', tx.modelVersion],
        ['Processing time', tx.timings ? `${ms(tx.timings.totalMs)} total · ${ms(tx.timings.scoreMs)} in the fraud engine` : 'not measured (older payment)'],
        ['Created', new Date(tx.createdAt).toLocaleString()]
      ]} />
    </Drawer>
  );
}

const STATUSES = ['COMPLETED', 'CHALLENGED', 'BLOCKED', 'PENDING_RISK_CHECK', 'FAILED'];

export default function TransactionsPage({ flash }) {
  const { data, reload } = useAdminData({ txns: '/admin/transactions?limit=300', flow: '/admin/dataflow' }, 8000);
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const txns = data.txns || [];

  const counts = useMemo(() => Object.fromEntries(STATUSES.map((s) => [s, txns.filter((t) => t.status === s).length])), [txns]);
  const shown = txns.filter((t) => (status === 'all' || t.status === status)
    && (!source || t.decisionSource === source)
    && (!q || `${t.txId} ${t.userId?.email || ''} ${t.userId?.fullName || ''} ${t.merchant || ''}`.toLowerCase().includes(q.toLowerCase())));
  const volume = shown.reduce((a, t) => a + (t.amount || 0), 0);

  return (
    <>
      <PageHead title="Transactions" sub="Every payment with its fraud score, decision and processing path. Click a row for details and actions." />
      <ProcessingMonitor hot={data.flow?.hot} onFilter={setStatus} />
      <div className="toolbar">
        <Tabs value={status} onChange={setStatus} tabs={[{ id: 'all', label: 'All', count: txns.length }, ...STATUSES.map((s) => ({ id: s, label: s === 'PENDING_RISK_CHECK' ? 'Stuck' : s[0] + s.slice(1).toLowerCase(), count: counts[s] }))]} />
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 'auto' }} title="Who decided">
            <option value="">Any decision source</option>
            <option value="HEURISTIC">Base model (rules)</option>
            <option value="ML_MODEL">ML model</option>
            <option value="RULES_FALLBACK">Fallback rules</option>
            <option value="ADMIN">Admin adjustments</option>
          </select>
          <input placeholder="Search tx, user, merchant…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 230 }} />
        </div>
      </div>
      <div className="card">
        <div className="card-title"><h3>{int(shown.length)} transactions · {money(volume)}</h3></div>
        {shown.length === 0
          ? <Empty icon="💳" title="No transactions" text="Nothing matches these filters." />
          : (
            <div className="table-wrap">
              <table className="data clickable">
                <thead><tr><th>Tx</th><th>Customer</th><th>Type</th><th>Amount</th><th>Status</th><th>Risk</th><th>Decided by</th><th title="Request received → decision saved">Time</th><th>Lakehouse</th><th>When</th></tr></thead>
                <tbody>
                  {shown.map((t) => (
                    <tr key={t._id} onClick={() => setOpen(t)}>
                      <td className="mono">{t.txId}</td>
                      <td>{t.userId?.fullName || t.userId?.email || '—'}</td>
                      <td className="faint">{t.type}</td>
                      <td className="amount">{money(t.amount)}</td>
                      <td><span className={`badge ${t.status}`}>{t.status === 'PENDING_RISK_CHECK' ? 'STUCK' : t.status}</span></td>
                      <td><RiskBadge p={t.fraudProbability} /></td>
                      <td className="faint">{{ HEURISTIC: 'base model', ML_MODEL: 'ML model', RULES_FALLBACK: 'fallback', ADMIN: 'admin' }[t.decisionSource] || '—'}</td>
                      <td className="faint">{ms(t.timings?.totalMs)}</td>
                      <td>{t.lakeLandedAt ? <span className="badge LOW" title={new Date(t.lakeLandedAt).toLocaleString()}>landed</span> : <span className="faint">—</span>}</td>
                      <td className="faint" style={{ whiteSpace: 'nowrap' }}>{timeAgo(t.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
      {open && <TxDetail tx={open} flash={flash} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}
