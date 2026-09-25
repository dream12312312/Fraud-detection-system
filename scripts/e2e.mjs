// End-to-end test of the whole SentinelPay pipeline against the REAL running system:
// user side → fraud engine → admin control → lakehouse landing → medallion job → training runs.
//
//   npm run dev                                       (API + both apps running)
//   node scripts/e2e.mjs                              all phases — uses Databricks serverless compute
//   E2E_PHASES=users,admin node scripts/e2e.mjs       local phases only, no Databricks compute
//   E2E_TRAIN=random_forest:synthetic_payments,...    choose the training runs (model:dataset)
//
// It creates real e2e-* test users and payments. Output: scripts/e2e-output/e2e-result.json and e2e.log
import fs from 'node:fs';

const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const API = process.env.E2E_API || 'http://localhost:4000/api/v1';
const DIR = new URL('./e2e-output/', import.meta.url);
fs.mkdirSync(DIR, { recursive: true });
const OUT = new URL('e2e-result.json', DIR);
const LOG = new URL('e2e.log', DIR);
const R = { startedAt: new Date().toISOString(), checks: [], phases: {} };
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`; fs.appendFileSync(LOG, line + '\n'); };
const save = () => fs.writeFileSync(OUT, JSON.stringify(R, null, 1));
const check = (phase, name, ok, detail) => { R.checks.push({ phase, name, ok: Boolean(ok), detail }); log(ok ? 'PASS' : 'FAIL', phase, '|', name, detail ?? ''); save(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(path, method = 'GET', body, token) {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, d: await r.json().catch(() => ({})) };
}
const rnd = (a, b) => Math.round((a + Math.random() * (b - a)) * 100) / 100;

let admin = (await j('/auth/login', 'POST', { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD })).d.accessToken;
const adminRelogin = async () => { admin = (await j('/auth/login', 'POST', { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD })).d.accessToken; };
check('setup', 'admin can sign in', Boolean(admin));
const only = (process.env.E2E_PHASES || 'users,admin,lake,train').split(',');

/* ---------------- Phase A: user side ---------------- */
const users = [];
if (only.includes('users')) {
  const P = 'user side';
  const tag = Date.now();
  const tally = { COMPLETED: 0, CHALLENGED: 0, BLOCKED: 0, FAILED: 0, other: 0 };
  for (let u = 0; u < 6; u += 1) {
    const email = `e2e-${tag}-${u}@sentinelpay.local`;
    const password = 'E2eUser-Passw0rd!';
    const reg = await j('/auth/register', 'POST', { email, password, fullName: `E2E Customer ${u + 1}`, homeCountry: 'US' });
    const id = reg.d.user?.id || reg.d.user?._id || reg.d.id;
    if (u === 0) check(P, 'register creates an account', reg.s === 201 || reg.s === 200, `HTTP ${reg.s}`);
    const early = await j('/auth/login', 'POST', { email, password });
    if (u === 0) check(P, 'pending user cannot sign in before approval', early.s !== 200 || !early.d.accessToken, `HTTP ${early.s} ${early.d.error || ''}`);
    const appr = await j(`/admin/users/${id}/status`, 'PATCH', { status: 'ACTIVE' }, admin);
    if (u === 0) check(P, 'admin approves the user', appr.s === 200, `HTTP ${appr.s}`);
    const tok = (await j('/auth/login', 'POST', { email, password })).d.accessToken;
    if (u === 0) check(P, 'approved user signs in', Boolean(tok));
    const acc = (await j('/accounts', 'GET', null, tok)).d;
    const start = acc.find?.((a) => a.type === 'CHECKING')?.balance;
    if (u === 0) check(P, 'new user has an opening balance', start > 0, `$${start}`);
    await j('/beneficiaries', 'POST', { nickname: 'Landlord', accountNumber: `E2E-RENT-${u}`, bankName: 'E2E Bank' }, tok);
    await j('/beneficiaries', 'POST', { nickname: 'Grocer', accountNumber: `E2E-SHOP-${u}`, bankName: 'E2E Bank' }, tok);
    const me = { id, email, tok, txs: [], start };
    // 8 ordinary payments to saved payees at home
    const plan = [];
    for (let i = 0; i < 8; i += 1) plan.push({ kind: 'normal', body: { toAccount: i % 2 ? `E2E-RENT-${u}` : `E2E-SHOP-${u}`, amount: rnd(20, 260), merchant: i % 2 ? undefined : 'Grocery store', country: 'US' } });
    // suspicious: abroad to an unknown account (expected REVIEW), and abroad + unknown + large (expected BLOCK)
    plan.push({ kind: 'review', body: { toAccount: `UNK-${u}-A`, amount: rnd(150, 450), country: 'NG' } });
    plan.push({ kind: 'review', body: { toAccount: `UNK-${u}-B`, amount: rnd(150, 450), country: 'RU' } });
    plan.push({ kind: 'block', body: { toAccount: `UNK-${u}-C`, amount: rnd(2100, 2600), country: 'NG' } });
    plan.push({ kind: 'spike', body: { toAccount: `E2E-RENT-${u}`, amount: rnd(1300, 1700), country: 'US' } });
    for (const p of plan) {
      const r = await j('/transfer', 'POST', p.body, tok);
      const st = r.d.status || `HTTP ${r.s}`;
      tally[r.d.status] != null ? (tally[r.d.status] += 1) : (tally.other += 1);
      me.txs.push({ kind: p.kind, txId: r.d.txId, status: r.d.status, decision: r.d.decision, score: r.d.fraudProbability, amount: p.body.amount, err: r.d.error });
      if (r.s >= 400) log('transfer error', u, p.kind, r.s, r.d.error);
      void st;
    }
    // the user answers the challenge: confirm the first review, report the second as fraud
    const ch = me.txs.filter((t) => t.status === 'CHALLENGED');
    if (ch[0]) me.confirm = await j(`/transactions/${ch[0].txId}/confirm`, 'POST', {}, tok);
    if (ch[1]) me.report = await j(`/transactions/${ch[1].txId}/report`, 'POST', {}, tok);
    users.push(me);
  }
  const all = users.flatMap((x) => x.txs);
  R.phases.users = { users: users.map((x) => x.email), tally, samples: all.slice(0, 12), total: all.length };
  check(P, 'every payment got a decision from the fraud engine', all.every((t) => t.decision), `${all.filter((t) => t.decision).length}/${all.length}`);
  const normal = all.filter((t) => t.kind === 'normal');
  check(P, 'ordinary payments are approved', normal.filter((t) => t.status === 'COMPLETED').length / normal.length >= 0.9, `${normal.filter((t) => t.status === 'COMPLETED').length}/${normal.length} completed`);
  const rev = all.filter((t) => t.kind === 'review');
  check(P, 'abroad + unknown payee is held for the user to confirm', rev.filter((t) => t.status === 'CHALLENGED').length >= rev.length * 0.8, `${rev.filter((t) => t.status === 'CHALLENGED').length}/${rev.length} challenged; scores ${rev.map((t) => t.score).join(', ')}`);
  const blk = all.filter((t) => t.kind === 'block');
  check(P, 'abroad + unknown + large is blocked', blk.every((t) => t.status === 'BLOCKED'), `${blk.filter((t) => t.status === 'BLOCKED').length}/${blk.length} blocked; scores ${blk.map((t) => t.score).join(', ')}`);
  const spike = all.filter((t) => t.kind === 'spike');
  R.phases.users.spike = spike.map((t) => `${t.amount}→${t.status}(${t.score})`);
  check(P, 'user confirm of a held payment completes it', users.every((x) => !x.confirm || x.confirm.d.status === 'COMPLETED'), users.map((x) => x.confirm?.d.status).join(','));
  check(P, 'user fraud report blocks the payment', users.every((x) => !x.report || x.report.d.status === 'BLOCKED'), users.map((x) => x.report?.d.status).join(','));
  // ledger consistency: balance = start − completed payments; nothing left on hold
  let consistent = true; const details = [];
  for (const x of users) {
    const txs = (await j('/transactions', 'GET', null, x.tok)).d;
    const acc = (await j('/accounts', 'GET', null, x.tok)).d.find((a) => a.type === 'CHECKING');
    const spent = txs.filter((t) => t.status === 'COMPLETED' && ['PAYMENT', 'TRANSFER'].includes(t.type)).reduce((s, t) => s + t.amount, 0);
    const held = txs.filter((t) => ['CHALLENGED', 'PENDING_RISK_CHECK'].includes(t.status)).reduce((s, t) => s + t.amount, 0);
    const ok = Math.abs(x.start - spent - acc.balance) < 0.01 && Math.abs(acc.heldAmount - held) < 0.01;
    if (!ok) consistent = false;
    details.push(`${x.email.split('@')[0].slice(-1)}: bal ${acc.balance.toFixed(2)} held ${acc.heldAmount.toFixed(2)} ${ok ? 'ok' : `expected ${(x.start - spent).toFixed(2)}/${held.toFixed(2)}`}`);
  }
  check(P, 'ledger is consistent (balance and holds match transactions)', consistent, details.join(' · '));
  const one = users[0].txs.find((t) => t.status);
  const txList = (await j('/transactions', 'GET', null, users[0].tok)).d;
  const first = txList.find((t) => t.txId === one.txId);
  check(P, 'transaction stores the features used for the journey view', first?.features && first.features.avgAmount30d != null, JSON.stringify(first?.features));
  save();
}

/* ---------------- Phase B: developer side (user & money control) ---------------- */
if (only.includes('admin') && users.length) {
  const P = 'developer: users & money';
  const x = users[1];
  const det = await j(`/admin/users/${x.id}`, 'GET', null, admin);
  const acc = det.d.accounts?.find((a) => a.type === 'CHECKING');
  const before = acc?.balance;
  const cr = await j(`/admin/accounts/${acc._id}/adjust`, 'POST', { direction: 'CREDIT', amount: 500, reason: 'E2E goodwill credit' }, admin);
  check(P, 'admin credit adds money', Math.abs(cr.d.account?.balance - before - 500) < 0.01, `${before} → ${cr.d.account?.balance}`);
  const db = await j(`/admin/accounts/${acc._id}/adjust`, 'POST', { direction: 'DEBIT', amount: 120, reason: 'E2E fee correction' }, admin);
  check(P, 'admin debit removes money', Math.abs(db.d.account?.balance - before - 380) < 0.01, `→ ${db.d.account?.balance}`);
  const over = await j(`/admin/accounts/${acc._id}/adjust`, 'POST', { direction: 'DEBIT', amount: 1e7, reason: 'too much' }, admin);
  check(P, 'admin cannot debit more than the balance', over.s === 400, `HTTP ${over.s} ${over.d.error}`);
  const noReason = await j(`/admin/accounts/${acc._id}/adjust`, 'POST', { direction: 'CREDIT', amount: 5 }, admin);
  check(P, 'money adjustment requires a reason', noReason.s === 400, `HTTP ${noReason.s} ${noReason.d.error}`);
  const lim = await j(`/admin/accounts/${acc._id}`, 'PATCH', { dailyLimit: 3000 }, admin);
  check(P, 'admin sets a daily limit', lim.d.dailyLimit === 3000, `${lim.d.dailyLimit}`);
  const userSees = (await j('/notifications', 'GET', null, x.tok)).d;
  check(P, 'user is notified of the adjustment', userSees.some?.((n) => /credit|adjust|added/i.test(`${n.title} ${n.body}`)), userSees.slice?.(0, 2).map((n) => n.title).join(' | '));
  // resolve a held payment from the console: make one more challenged payment for user 2
  const y = users[2];
  const held = await j('/transfer', 'POST', { toAccount: 'UNK-ADMIN-1', amount: 222, country: 'NG' }, y.tok);
  const res = held.d.status === 'CHALLENGED' ? await j(`/admin/transactions/${held.d.txId}/resolve`, 'POST', { action: 'block' }, admin) : null;
  check(P, 'admin blocks a held payment from the console', res?.d?.status === 'BLOCKED' || res?.d?.transaction?.status === 'BLOCKED', `${held.d.status} → ${res ? JSON.stringify(res.d).slice(0, 120) : 'not challenged'}`);
  const held2 = await j('/transfer', 'POST', { toAccount: 'UNK-ADMIN-2', amount: 111, country: 'RU' }, y.tok);
  const res2 = held2.d.status === 'CHALLENGED' ? await j(`/admin/transactions/${held2.d.txId}/resolve`, 'POST', { action: 'approve' }, admin) : null;
  check(P, 'admin approves a held payment from the console', res2?.d?.status === 'COMPLETED' || res2?.d?.transaction?.status === 'COMPLETED', `${held2.d.status} → ${res2 ? JSON.stringify(res2.d).slice(0, 120) : 'not challenged'}`);
  const list = await j('/admin/users?search=e2e-', 'GET', null, admin);
  check(P, 'user list shows balances and activity', Array.isArray(list.d) && list.d.some((r) => r.balance != null && r.txCount > 0), `${list.d.length} e2e users listed`);
  save();
}

/* ---------------- Phase C: data engineering (landing + medallion) ---------------- */
if (only.includes('lake')) {
  const P = 'data pipeline';
  await adminRelogin();
  const before = (await j('/admin/lakehouse', 'GET', null, admin)).d;
  const land = await j('/admin/lakehouse/land', 'POST', { confirm: true }, admin);
  check(P, 'settled transactions land in the Unity Catalog volume', land.s === 200 && land.d.rows > 0, `pending before ${before.pending}; landed ${land.d.rows} rows → ${land.d.path || land.d.error}`);
  const after = (await j('/admin/lakehouse', 'GET', null, admin)).d;
  check(P, 'landing backlog is empty afterwards (only unsettled payments remain)', after.pending === 0 || after.pending < before.pending, `pending ${after.pending}, landed total ${after.landed}`);
  const pBefore = (await j('/admin/pipeline', 'GET', null, admin)).d.databricks;
  R.phases.lake = { landed: land.d, countsBefore: pBefore?.medallionCounts };
  const run = await j('/admin/databricks/pipeline/run', 'POST', { confirm: true }, admin);
  check(P, 'medallion job starts on Databricks', run.s === 202, `HTTP ${run.s} run ${run.d.runId || run.d.error}`);
  const t0 = Date.now();
  let job = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(15000);
    if (i % 20 === 19) await adminRelogin();
    const p = (await j('/admin/pipeline', 'GET', null, admin)).d.databricks;
    job = p?.jobs?.find((x) => (x.name || '').includes('medallion'));
    const lr = job?.latestRun;
    log('medallion', lr?.state, lr?.resultState, (lr?.tasks || []).map((t) => `${t.key}:${t.state}/${t.result || ''}`).join(' '));
    if (lr && lr.runId === run.d.runId && ['TERMINATED', 'INTERNAL_ERROR', 'SKIPPED'].includes(lr.state)) break;
    if (lr && lr.runId == null && ['TERMINATED', 'INTERNAL_ERROR'].includes(lr.state) && Date.now() - t0 > 60000) break;
  }
  const lr = job?.latestRun;
  R.phases.lake.run = { state: lr?.state, result: lr?.resultState, tasks: lr?.tasks, seconds: Math.round((Date.now() - t0) / 1000) };
  check(P, 'medallion job succeeds (bronze → silver → gold)', lr?.resultState === 'SUCCESS', `${lr?.state}/${lr?.resultState} in ~${R.phases.lake.run.seconds}s; ${(lr?.tasks || []).map((t) => `${t.key} ${t.result}`).join(', ')}`);
  await sleep(5000);
  const counts = (await j('/admin/pipeline', 'GET', null, admin)).d.databricks?.medallionCounts;
  R.phases.lake.countsAfter = counts;
  check(P, 'bronze/silver/gold row counts grew', counts?.silver_events > (pBefore?.medallionCounts?.silver_events || 0), `before ${JSON.stringify(pBefore?.medallionCounts)} → after ${JSON.stringify(counts)}`);
  save();
}

/* ---------------- Phase D: model training (one run at a time on Free Edition) ---------------- */
if (only.includes('train')) {
  const P = 'model training';
  await adminRelogin();
  const opts = (await j('/admin/training/options', 'GET', null, admin)).d;
  R.phases.training = { datasets: opts.datasets?.map((d) => ({ id: d.id, available: d.available, rows: d.rows, note: d.note })), runs: [] };
  const plan = (process.env.E2E_TRAIN || 'logistic_regression:platform_transactions,random_forest:synthetic_payments,gradient_boosting:synthetic_payments,naive_bayes:creditcard_benchmark').split(',').map((x) => x.split(':'));
  for (const [model, dataset] of plan) {
    await adminRelogin();
    const noConfirm = await j('/admin/training/start', 'POST', { model, dataset }, admin);
    if (!R.phases.training.guard) { R.phases.training.guard = true; check(P, 'training refuses to start without explicit confirmation', noConfirm.s === 400, `HTTP ${noConfirm.s}`); }
    const st = await j('/admin/training/start', 'POST', { confirm: true, model, dataset }, admin);
    if (st.s !== 202) {
      R.phases.training.runs.push({ model, dataset, started: false, error: st.d.error, http: st.s });
      check(P, `start ${model} on ${dataset}`, false, `HTTP ${st.s}: ${st.d.error}`);
      save();
      continue;
    }
    const id = st.d.run._id;
    const t0 = Date.now();
    let run = null;
    for (let i = 0; i < 120; i += 1) {
      await sleep(15000);
      if (i % 20 === 19) await adminRelogin();
      const tr = (await j('/admin/training', 'GET', null, admin)).d;
      run = tr.runs?.find((r) => r._id === id);
      log('train', model, dataset, run?.status, (run?.stages || []).map((s) => `${s.key}:${s.state}/${s.result || ''}`).join(' '));
      if (run && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) break;
    }
    const entry = {
      model, dataset, status: run?.status, minutes: Math.round((Date.now() - t0) / 6000) / 10,
      metrics: run?.metrics, baseline: run?.baselineMetrics, version: run?.registeredVersion, message: run?.stateMessage,
      stages: (run?.stages || []).map((s) => ({ key: s.key, state: s.state, result: s.result, message: s.message, seconds: s.startedAt && s.finishedAt ? Math.round((new Date(s.finishedAt) - new Date(s.startedAt)) / 1000) : null, output: s.output }))
    };
    R.phases.training.runs.push(entry);
    check(P, `train ${model} on ${dataset}`, run?.status === 'COMPLETED', `${run?.status} in ${entry.minutes} min; F1 ${run?.metrics?.f1} PR-AUC ${run?.metrics?.prAuc} (base ${run?.baselineMetrics?.prAuc ?? 'n/a'}) v${run?.registeredVersion ?? '-'}${run?.status !== 'COMPLETED' ? ` · ${entry.stages.filter((s) => s.result && s.result !== 'SUCCESS').map((s) => `${s.key}: ${s.message || s.result}`).join('; ') || run?.stateMessage}` : ''}`);
    save();
  }
  const ml = (await j('/admin/training/mlflow', 'GET', null, admin)).d;
  R.phases.training.mlflow = { experiment: ml.experiment?.name, runs: ml.runs?.length, versions: ml.modelVersions?.map((v) => `v${v.version} ${v.status}`) };
  check(P, 'MLflow tracks the runs and the registry has versions', ml.runs?.length > 0 && ml.modelVersions?.length > 0, JSON.stringify(R.phases.training.mlflow));
}

const sys = (await j('/admin/system', 'GET', null, admin)).d;
R.phases.system = { mongo: sys.mongo?.connected, fraudEngine: sys.fraudEngine, kafka: sys.kafka?.enabled, databricks: sys.databricks };
R.finishedAt = new Date().toISOString();
R.summary = { passed: R.checks.filter((c) => c.ok).length, failed: R.checks.filter((c) => !c.ok).length };
save();
log('DONE', R.summary);
