import React from 'react';

const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const reasonText = (r) => (r || []).join(', ').replaceAll('_', ' ').toLowerCase();
const SCORER = { ML_MODEL: 'our machine-learning model', HEURISTIC: 'our fraud engine (base model)', RULES_FALLBACK: 'backup safety rules', ADMIN: 'the SentinelPay team' };

/**
 * What happened to one payment, step by step, using only fields stored on the
 * transaction (features, decision source, status, lakehouse landing time).
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
  const decided = tx.decision === 'APPROVE' ? 'approved' : tx.decision === 'REVIEW' ? 'needs your confirmation' : tx.decision === 'BLOCK' ? 'blocked' : '—';
  const steps = [
    { cls: 'ok', t: 'Payment received', d: `${new Date(tx.createdAt).toLocaleString()} · ${money(tx.amount)} put on hold until checked` },
    { cls: tx.features ? 'ok' : 'todo', t: 'Risk signals measured', d: tx.features
      ? [`${f.velocity1h ?? 0} payment(s) in the last hour`, `your 30-day average ${money(f.avgAmount30d)}`, f.isNewBeneficiary ? 'new payee' : 'saved payee', tx.country !== (f.homeCountry || 'US') ? `abroad (${tx.country})` : 'in your home country'].join(' · ')
      : 'not recorded for this older payment' },
    { cls: tx.fraudProbability != null ? 'ok' : 'todo', t: `Checked by ${SCORER[tx.decisionSource] || 'our fraud engine'}`, d: tx.fraudProbability != null ? `risk score ${Math.round(tx.fraudProbability * 100)}%${reasonText(tx.reasons) ? ` · ${reasonText(tx.reasons)}` : ' · no warning signs'}` : 'not scored yet' },
    { cls: tx.decision === 'BLOCK' ? 'bad' : tx.decision === 'REVIEW' ? 'warn' : tx.decision ? 'ok' : 'todo', t: `Decision: ${decided}`, d: { COMPLETED: 'money sent', CHALLENGED: 'waiting for you to confirm or report it', BLOCKED: 'no money left your account', FAILED: 'could not be completed', PENDING_RISK_CHECK: 'still being checked' }[tx.status] || tx.status },
    { cls: tx.lakeLandedAt ? 'ok' : 'todo', t: 'Added to our analytics data', d: tx.lakeLandedAt ? `anonymised copy stored ${new Date(tx.lakeLandedAt).toLocaleDateString()} — helps train better fraud models` : 'happens in the next data-pipeline batch' }
  ];
  const decisionIco = tx.decision === 'BLOCK' ? '⛔' : tx.decision === 'REVIEW' ? '⚠️' : '✅';
  return (
    <>
      <PaymentPath steps={steps} icons={['📱', '📏', '🧠', decisionIco, '🌊']} labels={['You', 'Signals', 'Fraud check', 'Decision', 'Data lake']} />
      <ol className="journey">
        {steps.map((s) => <li key={s.t} className={s.cls}><div className="j-t">{s.t}</div><div className="j-d">{s.d}</div></li>)}
      </ol>
    </>
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
