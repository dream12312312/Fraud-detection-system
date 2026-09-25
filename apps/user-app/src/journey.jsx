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
const reasonList = (r) => (r || []).filter((x) => !SETTLED.includes(x));

/**
 * What happened to one payment, step by step, using only fields stored on the
 * transaction (features, decision source, status, timings, lakehouse landing time).
 */
export function PaymentJourney({ tx }) {
  const f = tx.features || {};
  if (tx.decisionSource === 'ADMIN') {
    return (
      <ol className="journey">
        <li className="ok"><div className="j-t">Adjusted by the SentinelPay team</div><div className="j-d">{tx.adminNote || tx.merchant}</div></li>
        <li className="ok"><div className="j-t">Balance updated</div><div className="j-d">{money(tx.amount)} {tx.type === 'DEPOSIT' ? 'added' : 'withdrawn'}</div></li>
      </ol>
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
  const decisionCls = tx.status === 'BLOCKED' ? 'bad' : tx.status === 'CHALLENGED' ? 'warn' : tx.decision ? 'ok' : 'todo';

  const scoreMs = tx.timings?.scoreMs;
  const totalMs = tx.timings?.totalMs;
  const foreign = tx.features && tx.country !== (f.homeCountry || 'US');

  const steps = [
    { cls: 'ok', t: 'Payment received', body: (
      <>
        <div className="j-d">{new Date(tx.createdAt).toLocaleString()} · <b>{money(tx.amount)}</b> put on hold, not moved yet</div>
      </>
    ) },
    { cls: tx.features ? 'ok' : 'todo', t: 'Risk signals measured', body: tx.features ? (
      <ul className="j-chips">
        <li className={f.isNewBeneficiary ? 'flag' : ''}>{f.isNewBeneficiary ? '🆕 New payee' : '💾 Saved payee'}</li>
        <li className={foreign ? 'flag' : ''}>{foreign ? `🌍 Abroad (${tx.country})` : '🏠 Home country'}</li>
        <li className={f.velocity1h >= 5 ? 'flag' : ''}>⚡ {f.velocity1h ?? 0} payment(s)/hour</li>
        <li className={tx.amount > (f.avgAmount30d || 0) * 4 ? 'flag' : ''}>📈 30-day average {money(f.avgAmount30d)}</li>
      </ul>
    ) : <div className="j-d">not recorded for this older payment</div> },
    { cls: tx.fraudProbability != null ? 'ok' : 'todo', t: 'Scored for fraud risk', body: tx.fraudProbability != null ? (
      <>
        <div className="j-d">
          by {SCORER[tx.decisionSource] || 'our fraud engine'}
          {SCORER_SHORT[tx.decisionSource] && <span className={`src-tag ${tx.decisionSource === 'ML_MODEL' ? 'ml' : ''}`}>{SCORER_SHORT[tx.decisionSource]}</span>}
          {scoreMs != null && <span className="j-time">⏱ {scoreMs} ms</span>}
        </div>
        <RiskGauge prob={tx.fraudProbability} />
        {reasons.length > 0 ? (
          <ul className="j-reasons">
            {reasons.map((code) => <li key={code}>{REASON_TEXT[code] || code.replaceAll('_', ' ').toLowerCase()}</li>)}
          </ul>
        ) : <div className="j-d faint">Nothing unusual found.</div>}
      </>
    ) : <div className="j-d">not scored yet</div> },
    { cls: decisionCls, t: `Decision: ${decided}`, body: <div className="j-d">{outcome}</div> },
    { cls: tx.lakeLandedAt ? 'ok' : 'todo', t: 'Added to our analytics data', body: (
      <div className="j-d">{tx.lakeLandedAt ? `anonymised copy stored ${new Date(tx.lakeLandedAt).toLocaleDateString()} — helps train better fraud models` : 'happens in the next data-pipeline batch'}</div>
    ) }
  ];
  const decisionIco = tx.status === 'BLOCKED' ? '⛔' : tx.status === 'CHALLENGED' ? '⚠️' : '✅';

  return (
    <>
      <Verdict tx={tx} totalMs={totalMs} decisionIco={decisionIco} decided={decided} outcome={outcome} />
      <PaymentPath steps={steps} icons={['📱', '📏', '🧠', decisionIco, '🌊']} labels={['You', 'Signals', 'Fraud check', 'Decision', 'Data lake']} />
      <ol className="journey">
        {steps.map((s) => <li key={s.t} className={s.cls}><div className="j-t">{s.t}</div>{s.body}</li>)}
      </ol>
    </>
  );
}

/** One-sentence, plain-language summary of the whole payment, up top. */
function Verdict({ tx, totalMs, decisionIco, decided, outcome }) {
  const sentence = {
    COMPLETED: 'This payment looked normal and went through.',
    CHALLENGED: 'This payment looked unusual — we need you to confirm it is really you.',
    BLOCKED: 'This payment looked like fraud, so we stopped it before any money moved.',
    FAILED: 'This payment could not be completed.',
    PENDING_RISK_CHECK: 'This payment is still being checked.'
  }[tx.status] || `${decided}: ${outcome}`;
  return (
    <div className={`verdict ${tx.status === 'BLOCKED' ? 'bad' : tx.status === 'CHALLENGED' ? 'warn' : 'ok'}`}>
      <span className="v-ico">{decisionIco}</span>
      <div className="v-body">
        <div className="v-sentence">{sentence}</div>
        <div className="v-meta">{money(tx.amount)} · {tx.txId}{totalMs != null && <span className="j-time"> · handled in {totalMs} ms</span>}</div>
      </div>
    </div>
  );
}

/** The same steps as a compact path: lit stops are done, the flowing link shows where the payment is now. */
function PaymentPath({ steps, icons, labels }) {
  return (
    <div className="ppath" role="img" aria-label={`Payment path: ${steps.map((s, i) => `${labels[i]} ${s.cls === 'todo' ? 'pending' : 'done'}`).join(', ')}`}>
      {steps.map((s, i) => (
        <React.Fragment key={labels[i]}>
          {i > 0 && <span className={`pp-link ${s.cls}`} />}
          <div className={`pp-node ${s.cls}`}><span className="pp-ico">{icons[i]}</span><span className="pp-l">{labels[i]}</span></div>
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
