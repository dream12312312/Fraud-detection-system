import React from 'react';
import { RiskGauge } from './charts.jsx';

const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const SETTLED = ['USER_REPORTED_FRAUD', 'ADMIN_APPROVED', 'ADMIN_BLOCKED'];
const SCORER = { ML_MODEL: 'our machine-learning model', HEURISTIC: 'our fraud engine (base model)', RULES_FALLBACK: 'backup safety rules', ADMIN: 'the SentinelPay team' };
const SCORER_SHORT = { ML_MODEL: 'ML model', HEURISTIC: 'base engine', RULES_FALLBACK: 'backup rules' };
// plain-language explanations for the engine's own reason codes, worst-first
const REASON_TEXT = {
  AMOUNT_12X_USER_AVG: 'the amount is over 12× what you usually send',
  AMOUNT_MUCH_HIGHER_THAN_AVG: 'the amount is much higher than what you usually send',
  AMOUNT_HIGHER_THAN_AVG: 'the amount is higher than what you usually send',
  NIGHT_TIME_LARGE_AMOUNT: 'a large payment sent late at night',
  NEW_COUNTRY: 'going to a country you have not sent money to before',
  FOREIGN_LARGE_AMOUNT: 'a large payment going abroad',
  NEW_BENEFICIARY: 'sent to a payee you have not paid before',
  NEW_BENEFICIARY_LARGE_AMOUNT: 'a large first payment to a new payee',
  HIGH_VELOCITY: 'several payments in a short time',
  HIGH_VALUE_TRANSACTION: 'an unusually large payment'
};
const REASON_ICO = {
  AMOUNT_12X_USER_AVG: '💰', AMOUNT_MUCH_HIGHER_THAN_AVG: '💰', AMOUNT_HIGHER_THAN_AVG: '💰', HIGH_VALUE_TRANSACTION: '💰',
  NIGHT_TIME_LARGE_AMOUNT: '🌙', NEW_COUNTRY: '🌍', FOREIGN_LARGE_AMOUNT: '🌍',
  NEW_BENEFICIARY: '🆕', NEW_BENEFICIARY_LARGE_AMOUNT: '🆕', HIGH_VELOCITY: '⚡'
};
const reasonList = (r) => (r || []).filter((x) => !SETTLED.includes(x));
// the fraud engine's own lines (services/fraud-engine/app.py)
const AMOUNT_X_HIGH = 4, AMOUNT_X_MUCH = 10, BUSY_PER_HOUR = 5, NIGHT_BEFORE = 6, NIGHT_LARGE = 1000;
const tone = (tx) => (tx.status === 'BLOCKED' ? 'bad' : tx.status === 'CHALLENGED' ? 'warn' : tx.status === 'FAILED' ? 'muted' : 'ok');

/**
 * What happened to one payment, using only fields stored on the transaction
 * (features, decision source, status, timings, lakehouse landing time).
 */
export function PaymentJourney({ tx, onDecide }) {
  const f = tx.features || {};
  if (tx.decisionSource === 'ADMIN') {
    return (
      <div className="pj">
        <div className="verdict ok">
          <span className="v-halo">🏦</span>
          <div className="v-body">
            <div className="v-top"><span className="v-kicker">Adjusted by the SentinelPay team</span><span className="v-amt">{money(tx.amount)}</span></div>
            <div className="v-sentence">{tx.adminNote || tx.merchant || 'Balance adjustment'}</div>
            <div className="v-meta"><span className="v-pill">{tx.type === 'DEPOSIT' ? '➕ added to' : '➖ taken from'} your balance</span><span className="v-pill mono">{tx.txId}</span></div>
          </div>
        </div>
      </div>
    );
  }
  // headline follows the payment's current status, not just the engine's original
  // verdict — a REVIEW that was since confirmed or blocked must say so, not "needs confirmation"
  const decided = { COMPLETED: 'approved', CHALLENGED: 'needs your confirmation', BLOCKED: 'blocked', FAILED: 'failed', PENDING_RISK_CHECK: 'being checked' }[tx.status] || '—';
  const r = tx.reasons || [];
  const reasons = reasonList(r);
  // who settled a payment the engine sent for confirmation
  const by = r.includes('USER_REPORTED_FRAUD') ? 'you reported it as fraud · '
    : r.includes('ADMIN_BLOCKED') ? 'blocked by the SentinelPay team · '
      : r.includes('ADMIN_APPROVED') ? 'approved by the SentinelPay team · '
        : tx.decision === 'REVIEW' && tx.status === 'COMPLETED' ? 'you confirmed it · ' : '';
  const outcome = {
    COMPLETED: `${by}money sent`,
    CHALLENGED: 'waiting for you to confirm or report it',
    BLOCKED: `${by}no money left your account`,
    FAILED: 'could not be completed',
    PENDING_RISK_CHECK: 'still being checked'
  }[tx.status] || tx.status;

  const scoreMs = tx.timings?.scoreMs;
  const totalMs = tx.timings?.totalMs;
  const signals = tx.features ? buildSignals(tx, f) : [];
  const unusual = signals.filter((s) => s.flag).length;
  const decisionIco = tx.status === 'BLOCKED' ? '⛔' : tx.status === 'CHALLENGED' ? '⚠️' : tx.status === 'FAILED' ? '✖️' : tx.status === 'PENDING_RISK_CHECK' ? '⏳' : '✅';
  const scored = tx.fraudProbability != null;

  const steps = [
    { cls: 'ok', ico: '📱', l: 'You', cap: new Date(tx.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
    { cls: tx.features ? (unusual ? 'warn' : 'ok') : 'todo', ico: '📏', l: 'Signals', cap: tx.features ? (unusual ? `${unusual} unusual` : 'all normal') : 'not recorded' },
    { cls: scored ? 'ok' : 'todo', ico: '🧠', l: 'Fraud check', cap: scored ? `${Math.round(tx.fraudProbability * 100)}% risk` : 'pending' },
    { cls: tx.status === 'BLOCKED' || tx.status === 'FAILED' ? 'bad' : tx.status === 'CHALLENGED' ? 'warn' : tx.decision ? 'ok' : 'todo', ico: decisionIco, l: 'Decision', cap: { COMPLETED: 'sent', CHALLENGED: 'on hold', BLOCKED: 'stopped', FAILED: 'failed', PENDING_RISK_CHECK: 'waiting' }[tx.status] || '—' },
    { cls: tx.lakeLandedAt ? 'ok' : 'todo', ico: '🌊', l: 'Data lake', cap: tx.lakeLandedAt ? `stored ${new Date(tx.lakeLandedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : 'next batch' }
  ];

  return (
    <div className="pj">
      <Verdict tx={tx} totalMs={totalMs} decisionIco={decisionIco} decided={decided} outcome={outcome} onDecide={onDecide} />
      <div className="pj-path-card">
        <PaymentPath steps={steps} />
        {totalMs != null && <SpeedBar totalMs={totalMs} scoreMs={scoreMs} />}
      </div>
      <div className="pj-grid">
        <section className="pj-card">
          <div className="pj-h"><span>🧠 Risk score</span>{SCORER_SHORT[tx.decisionSource] && <span className={`src-tag ${tx.decisionSource === 'ML_MODEL' ? 'ml' : ''}`}>{SCORER_SHORT[tx.decisionSource]}</span>}</div>
          {scored ? (
            <>
              <RiskGauge prob={tx.fraudProbability} />
              <div className="pj-sub">Why it scored {Math.round(tx.fraudProbability * 100)}%</div>
              {reasons.length > 0 ? (
                <ul className="pj-reasons">
                  {reasons.map((code) => <li key={code}><span className="pj-r-ico">{REASON_ICO[code] || '⚠️'}</span>{REASON_TEXT[code] || code.replaceAll('_', ' ').toLowerCase()}</li>)}
                </ul>
              ) : <div className="pj-clear">✓ Nothing unusual found</div>}
              <div className="pj-foot">Scored by {SCORER[tx.decisionSource] || 'our fraud engine'}{scoreMs != null && <> in <b>{scoreMs} ms</b></>}.</div>
            </>
          ) : <div className="pj-empty">⏳ Not scored yet.</div>}
        </section>
        <section className="pj-card">
          <div className="pj-h"><span>📏 What we checked</span>{tx.features && <span className={`pj-count ${unusual ? 'warn' : 'ok'}`}>{unusual ? `${unusual} of ${signals.length} unusual` : 'all normal'}</span>}</div>
          {tx.features
            ? <div className="pj-sigs">{signals.map((s) => <Signal key={s.k} {...s} />)}</div>
            : <div className="pj-empty">These signals were not recorded for this older payment.</div>}
        </section>
      </div>
    </div>
  );
}

/** The five signals the engine measured, each drawn against the line the engine itself uses. */
function buildSignals(tx, f) {
  const avg = f.avgAmount30d || 0;
  const ratio = avg ? tx.amount / avg : null;
  const top = Math.max(tx.amount, avg) || 1;
  const home = f.homeCountry || 'US';
  const foreign = (tx.country || home) !== home;
  const v = f.velocity1h ?? 0;
  const hour = f.hourOfDay ?? new Date(tx.createdAt).getUTCHours();
  const night = hour < NIGHT_BEFORE;
  return [
    {
      k: 'amt', wide: true, ico: '💰', l: 'Amount vs. your usual', flag: ratio != null && ratio > AMOUNT_X_HIGH,
      v: ratio == null ? 'first payment'
        : ratio < 1 ? `${Math.max(Math.round(ratio * 100), 1)}% of your 30-day average`
          : `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× your 30-day average`,
      viz: (
        <div className="pj-bars">
          <div className="pj-bar-row"><span>This payment</span><b>{money(tx.amount)}</b><i className="me" style={{ width: `${(tx.amount / top) * 100}%` }} /></div>
          <div className="pj-bar-row"><span>Your 30-day average</span><b>{money(avg)}</b><i style={{ width: `${(avg / top) * 100}%` }} /></div>
        </div>
      ),
      note: `The engine looks harder above ${AMOUNT_X_HIGH}× and much harder above ${AMOUNT_X_MUCH}×.`
    },
    {
      k: 'payee', ico: f.isNewBeneficiary ? '🆕' : '💾', l: 'Payee', flag: !!f.isNewBeneficiary,
      v: f.isNewBeneficiary ? 'New — never paid before' : 'Saved payee',
      viz: <div className="pj-route"><span className="pj-node">You</span><span className={`pj-wire ${f.isNewBeneficiary ? 'new' : ''}`} /><span className="pj-node">{f.isNewBeneficiary ? '?' : '✓'}</span></div>
    },
    {
      k: 'where', ico: foreign ? '🌍' : '🏠', l: 'Destination', flag: foreign,
      v: foreign ? `Abroad · ${tx.country}` : `Home country · ${home}`,
      viz: <div className="pj-route"><span className="pj-node">{home}</span><span className={`pj-wire ${foreign ? 'new' : ''}`} /><span className="pj-node">{tx.country || home}</span></div>
    },
    {
      k: 'pace', ico: '⚡', l: 'Pace', flag: v >= BUSY_PER_HOUR,
      v: `${v} payment${v === 1 ? '' : 's'} in the last hour`,
      viz: <div className="pj-pips" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <i key={i} className={`${i < v ? 'on' : ''} ${i >= BUSY_PER_HOUR - 1 ? 'hi' : ''}`} />)}</div>,
      note: `${BUSY_PER_HOUR} or more in an hour looks unusual.`
    },
    {
      k: 'time', ico: night ? '🌙' : '☀️', l: 'Time of day', flag: night && tx.amount > NIGHT_LARGE,
      v: `${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:59 UTC${night ? ' · night' : ''}`,
      viz: (
        <div className="pj-clock" aria-hidden="true">
          {Array.from({ length: 24 }, (_, h) => <i key={h} className={`${h < NIGHT_BEFORE ? 'night' : ''} ${h === hour ? 'now' : ''}`} />)}
          <div className="pj-clock-l"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
        </div>
      ),
      note: `Payments over $${NIGHT_LARGE.toLocaleString()} between 00:00 and 06:00 UTC get a closer look.`
    }
  ];
}

function Signal({ ico, l, v, flag, viz, note, wide }) {
  return (
    <div className={`pj-sig ${flag ? 'flag' : ''} ${wide ? 'wide' : ''}`}>
      <div className="pj-sig-h"><span className="pj-sig-ico">{ico}</span><span className="pj-sig-l">{l}</span><span className={`pj-tag ${flag ? 'flag' : ''}`}>{flag ? 'unusual' : 'normal'}</span></div>
      <div className="pj-sig-v">{v}</div>
      {viz}
      {note && <div className="pj-sig-n">{note}</div>}
    </div>
  );
}

/** How the total handling time splits between the fraud check and everything else. */
function SpeedBar({ totalMs, scoreMs }) {
  const score = scoreMs != null ? Math.min(scoreMs, totalMs) : null;
  const pct = score != null && totalMs ? Math.max((score / totalMs) * 100, 4) : 0;
  return (
    <div className="pj-speed">
      <div className="pj-speed-t"><span>⏱ Decided in <b>{totalMs} ms</b></span>{score != null && <span className="faint">fraud check {score} ms · saving and holding money {totalMs - score} ms</span>}</div>
      <div className="pj-speed-bar">{score != null && <i className="score" style={{ width: `${pct}%` }} />}<i className="rest" /></div>
    </div>
  );
}

/** One-sentence, plain-language summary of the whole payment, up top. */
function Verdict({ tx, totalMs, decisionIco, decided, outcome, onDecide }) {
  const [busy, setBusy] = React.useState(false);
  const act = async (kind) => { setBusy(true); try { await onDecide(tx, kind); } finally { setBusy(false); } };
  const r = tx.reasons || [];
  const settled = r.includes('USER_REPORTED_FRAUD') ? 'You reported this payment as fraud, so we stopped it before any money moved.'
    : r.includes('ADMIN_BLOCKED') ? 'Our fraud team stopped this payment before any money moved.'
      : r.includes('ADMIN_APPROVED') ? 'This payment looked unusual; our fraud team checked it and sent it.'
        : tx.decision === 'REVIEW' && tx.status === 'COMPLETED' ? 'This payment looked unusual; you confirmed it, so it went through.' : null;
  const sentence = settled || {
    COMPLETED: 'This payment looked normal and went through.',
    CHALLENGED: 'This payment looked unusual — we need you to confirm it is really you.',
    BLOCKED: 'This payment looked like fraud, so we stopped it before any money moved.',
    FAILED: 'This payment could not be completed.',
    PENDING_RISK_CHECK: 'This payment is still being checked.'
  }[tx.status] || `${decided}: ${outcome}`;
  const kicker = { COMPLETED: 'Sent', CHALLENGED: 'On hold · your answer needed', BLOCKED: 'Stopped', FAILED: 'Failed', PENDING_RISK_CHECK: 'Checking' }[tx.status] || tx.status;
  return (
    <div className={`verdict ${tone(tx)}`}>
      <span className="v-halo">{decisionIco}</span>
      <div className="v-body">
        <div className="v-top"><span className="v-kicker">{kicker}</span><span className="v-amt">{money(tx.amount)}</span></div>
        <div className="v-sentence">{sentence}</div>
        <div className="v-meta">
          <span className="v-pill mono">{tx.txId}</span>
          {tx.country && <span className="v-pill">📍 {tx.country}</span>}
          <span className="v-pill">📅 {new Date(tx.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
          {totalMs != null && <span className="v-pill">⏱ {totalMs} ms</span>}
        </div>
        {tx.status === 'CHALLENGED' && onDecide && (
          <div className="v-actions">
            <span>Did you make this payment? The money stays on hold until you answer.</span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm success" disabled={busy} onClick={() => act('confirm')}>Yes, send it</button>
              <button className="btn sm danger" disabled={busy} onClick={() => act('report')}>No, report fraud</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The steps as a stepper: lit stops are done, the flowing link shows where the payment is now. */
function PaymentPath({ steps }) {
  return (
    <div className="ppath" role="img" aria-label={`Payment path: ${steps.map((s) => `${s.l} ${s.cap}`).join(', ')}`}>
      {steps.map((s, i) => (
        <React.Fragment key={s.l}>
          {i > 0 && <span className={`pp-link ${s.cls}`} />}
          <div className={`pp-node ${s.cls}`} style={{ animationDelay: `${i * 90}ms` }}>
            <span className="pp-ico">{s.ico}</span>
            <span className="pp-l">{s.l}</span>
            <span className="pp-cap">{s.cap}</span>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

const PROTECT = [
  ['💸', 'You pay', 'The amount is held, not sent yet.'],
  ['📏', 'We measure', 'Amount vs. your usual, payee, country, time, pace.'],
  ['🧠', 'We score', 'The fraud engine rates the risk in milliseconds.'],
  ['✅', 'We decide', 'Approve, ask you to confirm, or block.'],
  ['🌊', 'We learn', 'Settled payments feed the data lake that trains new models.']
];

export function ProtectionStrip() {
  return (
    <div className="protect">
      {PROTECT.map(([ico, t, d], i) => (
        <React.Fragment key={t}>
          {i > 0 && <div className="protect-arrow" aria-hidden="true" />}
          <div className="protect-step"><span className="protect-ico">{ico}</span><b>{t}</b><span>{d}</span></div>
        </React.Fragment>
      ))}
    </div>
  );
}
