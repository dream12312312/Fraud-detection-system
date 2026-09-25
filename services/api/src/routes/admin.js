import { Router } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { User, Account, Beneficiary, Transaction, Notification, TrainingRun } from '../models.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { config } from '../config.js';
import {
  databricksSnapshot, medallionCounts, listMlflowExperiments, listMlflowRuns,
  runJob, getRun, getRunOutput, listModelVersions, taskState, latestAttempts, invalidateDatabricksCache, REGISTERED_MODEL
} from '../databricksClient.js';
import { provisionWorkspace, workspaceStatus, JOBS } from '../databricksProvision.js';
import { landingBacklog, landTransactions, benchmarkStatus, startStageBenchmark, benchmarkStageJob } from '../lakehouse.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/users', async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ email: rx }, { fullName: rx }];
  }
  const users = await User.find(q).select('-passwordHash').sort({ createdAt: -1 }).limit(200).lean();
  const ids = users.map((u) => u._id);
  const [accounts, txAgg] = await Promise.all([
    Account.find({ userId: { $in: ids } }).lean(),
    Transaction.aggregate([
      { $match: { userId: { $in: ids } } },
      { $group: { _id: '$userId', n: { $sum: 1 }, blocked: { $sum: { $cond: [{ $eq: ['$status', 'BLOCKED'] }, 1, 0] } },
        waiting: { $sum: { $cond: [{ $in: ['$status', ['CHALLENGED', 'PENDING_RISK_CHECK']] }, 1, 0] } }, last: { $max: '$createdAt' } } }
    ])
  ]);
  const tx = Object.fromEntries(txAgg.map((a) => [String(a._id), a]));
  res.json(users.map((u) => {
    const acc = accounts.filter((a) => String(a.userId) === String(u._id));
    const t = tx[String(u._id)] || {};
    return { ...u, balance: acc.reduce((s, a) => s + a.balance, 0), held: acc.reduce((s, a) => s + a.heldAmount, 0),
      accounts: acc.length, txCount: t.n || 0, blockedCount: t.blocked || 0, waitingCount: t.waiting || 0, lastTxAt: t.last || null };
  }));
});

/** Single user with everything the admin can manage (user detail view). */
router.get('/users/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid user id' });
  const [user, accounts, txns, beneficiaries, notifications] = await Promise.all([
    User.findById(req.params.id).select('-passwordHash'),
    Account.find({ userId: req.params.id }),
    Transaction.find({ userId: req.params.id }).sort({ createdAt: -1 }).limit(200),
    Beneficiary.find({ userId: req.params.id }).sort({ createdAt: -1 }),
    Notification.find({ userId: req.params.id }).sort({ createdAt: -1 }).limit(30)
  ]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const settled = txns.filter((t) => t.status === 'COMPLETED' && ['TRANSFER', 'PAYMENT'].includes(t.type));
  const summary = {
    totalSent: settled.reduce((a, t) => a + t.amount, 0),
    blocked: txns.filter((t) => t.status === 'BLOCKED').length,
    challenged: txns.filter((t) => t.status === 'CHALLENGED').length,
    stuck: txns.filter((t) => t.status === 'PENDING_RISK_CHECK').length,
    avgRisk: txns.length ? txns.reduce((a, t) => a + (t.fraudProbability || 0), 0) / txns.length : null
  };
  res.json({ user, accounts, transactions: txns, beneficiaries, notifications, summary });
});

const PROFILE_FIELDS = ['fullName', 'email', 'homeCountry', 'phone', 'role'];

/** Edit a user's profile (name, email, home country, phone, role). */
router.patch('/users/:id', async (req, res) => {
  try {
    const patch = Object.fromEntries(PROFILE_FIELDS.filter((k) => req.body?.[k] !== undefined).map((k) => [k, String(req.body[k]).trim()]));
    if (patch.role && !['user', 'admin'].includes(patch.role)) return res.status(400).json({ error: 'role must be user or admin' });
    if (patch.role === 'user' && String(req.user._id) === req.params.id) return res.status(400).json({ error: 'You cannot remove your own admin role.' });
    if (patch.email && await User.exists({ email: patch.email.toLowerCase(), _id: { $ne: req.params.id } })) return res.status(409).json({ error: 'Another user already has this email.' });
    if (patch.homeCountry) patch.homeCountry = patch.homeCountry.toUpperCase().slice(0, 2);
    const user = await User.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true }).select('-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    await Notification.create({ userId: user._id, title: 'Profile updated', body: 'An administrator updated your profile details.', type: 'INFO' });
    res.json(user);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/** Create a user directly (approved, with a one-time temporary password). */
router.post('/users', async (req, res) => {
  try {
    const { fullName, email, homeCountry = 'US', initialBalance = 5000, role = 'user' } = req.body ?? {};
    if (!fullName || !email) return res.status(400).json({ error: 'fullName and email are required' });
    if (await User.exists({ email: String(email).toLowerCase() })) return res.status(409).json({ error: 'A user with this email already exists.' });
    const bal = Number(initialBalance);
    if (!Number.isFinite(bal) || bal < 0) return res.status(400).json({ error: 'initialBalance must be ≥ 0' });
    const temp = `Sp-${crypto.randomBytes(6).toString('hex')}`;
    const user = await User.create({
      fullName, email, homeCountry: String(homeCountry).toUpperCase().slice(0, 2), role: role === 'admin' ? 'admin' : 'user',
      status: 'ACTIVE', passwordHash: await bcrypt.hash(temp, 10), mustChangePassword: true
    });
    const accountNumber = `SPY-${String(user._id).slice(-6).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
    await Account.create({ userId: user._id, accountNumber, balance: bal });
    console.log(`[admin] ${req.user.email} created user ${user.email}`);
    res.status(201).json({ user: { ...user.toObject(), passwordHash: undefined }, temporaryPassword: temp });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/** Delete a user and all of their data. */
router.delete('/users/:id', async (req, res) => {
  if (String(req.user._id) === req.params.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await Promise.all([
    Account.deleteMany({ userId: user._id }), Beneficiary.deleteMany({ userId: user._id }),
    Transaction.deleteMany({ userId: user._id }), Notification.deleteMany({ userId: user._id })
  ]);
  await user.deleteOne();
  console.log(`[admin] ${req.user.email} deleted user ${user.email}`);
  res.json({ ok: true });
});

const emitUserUpdate = (req, userId, payload) => req.app.get('io')?.to(`user:${userId}`).emit('transaction:update', payload);

/**
 * Credit or debit an account. Recorded as a DEPOSIT/WITHDRAWAL ledger entry with
 * the admin's reason (never fraud-scored, excluded from ML training data).
 */
router.post('/accounts/:id/adjust', async (req, res) => {
  const { direction, reason } = req.body ?? {};
  const amount = Number(req.body?.amount);
  if (!['CREDIT', 'DEBIT'].includes(direction)) return res.status(400).json({ error: 'direction must be CREDIT or DEBIT' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
  if (!reason || String(reason).trim().length < 3) return res.status(400).json({ error: 'A reason is required (it is shown to the user and kept in the ledger).' });
  const account = await Account.findById(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (direction === 'DEBIT' && account.balance - account.heldAmount < amount) {
    return res.status(400).json({ error: `Only $${(account.balance - account.heldAmount).toFixed(2)} is available (balance minus holds).` });
  }
  account.balance += direction === 'CREDIT' ? amount : -amount;
  await account.save();
  const tx = await Transaction.create({
    txId: `ADJ${crypto.randomBytes(4).toString('hex').toUpperCase()}${Date.now().toString().slice(-4)}`,
    userId: account.userId, type: direction === 'CREDIT' ? 'DEPOSIT' : 'WITHDRAWAL', amount,
    merchant: `Admin ${direction === 'CREDIT' ? 'credit' : 'debit'}`, status: 'COMPLETED',
    decisionSource: 'ADMIN', adminNote: `${String(reason).trim()} (by ${req.user.email})`
  });
  await Notification.create({ userId: account.userId, title: direction === 'CREDIT' ? 'Funds added' : 'Funds withdrawn',
    body: `$${amount.toFixed(2)} ${direction === 'CREDIT' ? 'credited to' : 'debited from'} ${account.accountNumber}: ${String(reason).trim()}`, type: 'INFO' });
  emitUserUpdate(req, account.userId, { txId: tx.txId, status: tx.status });
  console.log(`[admin] ${req.user.email} ${direction} $${amount} on ${account.accountNumber}: ${reason}`);
  res.json({ account, transaction: tx });
});

/** Change an account's daily limit. */
router.patch('/accounts/:id', async (req, res) => {
  const limit = Number(req.body?.dailyLimit);
  if (!Number.isFinite(limit) || limit < 0) return res.status(400).json({ error: 'dailyLimit must be ≥ 0' });
  const account = await Account.findByIdAndUpdate(req.params.id, { dailyLimit: limit }, { new: true });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json(account);
});

/** Open an extra account (e.g. savings) for a user. */
router.post('/users/:id/accounts', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const type = req.body?.type === 'CHECKING' ? 'CHECKING' : 'SAVINGS';
  if (type === 'CHECKING' && await Account.exists({ userId: user._id, type })) return res.status(409).json({ error: 'User already has a checking account.' });
  const accountNumber = `SPY-${String(user._id).slice(-6).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
  res.status(201).json(await Account.create({ userId: user._id, accountNumber, type, balance: 0 }));
});

/**
 * Resolve a transaction that is waiting (challenged, or stuck before scoring):
 * approve → money moves and the hold is released; block → only the hold is released.
 */
router.post('/transactions/:txId/resolve', async (req, res) => {
  const { action } = req.body ?? {};
  if (!['approve', 'block'].includes(action)) return res.status(400).json({ error: 'action must be approve or block' });
  const tx = await Transaction.findOne({ txId: req.params.txId });
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (!['CHALLENGED', 'PENDING_RISK_CHECK'].includes(tx.status)) return res.status(400).json({ error: `Only waiting transactions can be resolved (this one is ${tx.status}).` });
  const from = await Account.findOne({ userId: tx.userId, type: 'CHECKING' });
  if (from) {
    from.heldAmount = Math.max(0, from.heldAmount - tx.amount);
    if (action === 'approve') {
      if (from.balance < tx.amount) return res.status(400).json({ error: 'Insufficient balance to approve this payment.' });
      from.balance -= tx.amount;
    }
    await from.save();
  }
  tx.status = action === 'approve' ? 'COMPLETED' : 'BLOCKED';
  tx.adminNote = `${action === 'approve' ? 'Approved' : 'Blocked'} by ${req.user.email}`;
  tx.reasons = [...(tx.reasons || []), action === 'approve' ? 'ADMIN_APPROVED' : 'ADMIN_BLOCKED'];
  tx.updatedAt = new Date();
  await tx.save();
  await Notification.create({ userId: tx.userId, title: action === 'approve' ? 'Payment approved' : 'Payment blocked',
    body: `${tx.txId} ($${tx.amount.toFixed(2)}) was ${action === 'approve' ? 'approved' : 'blocked'} by our fraud team.`, type: action === 'approve' ? 'SUCCESS' : 'FRAUD_ALERT' });
  emitUserUpdate(req, tx.userId, { txId: tx.txId, status: tx.status });
  res.json(tx);
});

router.delete('/beneficiaries/:id', async (req, res) => {
  const b = await Beneficiary.findByIdAndDelete(req.params.id);
  if (!b) return res.status(404).json({ error: 'Beneficiary not found' });
  res.json({ ok: true });
});

router.patch('/users/:id/status', async (req, res) => {
  const { status } = req.body ?? {};
  const allowed = ['ACTIVE', 'DISABLED', 'BLOCKED', 'PENDING'];
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
  const user = await User.findByIdAndUpdate(req.params.id, { status }, { new: true }).select('-passwordHash');
  if (!user) return res.status(404).json({ error: 'User not found' });
  await Notification.create({ userId: user._id, title: 'Account update', body: `Your account status changed to ${status}.`, type: status === 'ACTIVE' ? 'INFO' : 'WARNING' });
  res.json(user);
});

/**
 * Set a temporary password for a user.
 * - A cryptographically random password is generated server-side; the plaintext
 *   is returned ONCE in this response so the admin can hand it over out of band.
 * - Only the bcrypt hash is stored; mustChangePassword forces the user to set
 *   their own password at next login.
 * - No password value is ever logged or stored in plaintext.
 */
router.post('/users/:id/temp-password', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const temp = `Sp-${crypto.randomBytes(6).toString('hex')}`; // e.g. Sp-1a2b3c4d5e6f
    user.passwordHash = await bcrypt.hash(temp, 10);
    user.mustChangePassword = true;
    await user.save();
    await Notification.create({
      userId: user._id,
      title: 'Temporary password set',
      body: 'An administrator issued a temporary password. Please sign in and change it immediately.',
      type: 'WARNING'
    });
    console.log(`[admin] temporary password set for user ${user.email} (hash stored, plaintext not logged)`);
    res.json({ ok: true, temporaryPassword: temp, mustChangePassword: true, message: 'Share this password with the user through a secure channel. They must change it at next sign-in.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/transactions', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const q = {};
  if (req.query.status) q.status = req.query.status;
  const txns = await Transaction.find(q).sort({ createdAt: -1 }).limit(limit).populate('userId', 'fullName email');
  res.json(txns);
});

router.get('/stats', async (_req, res) => {
  const [totalTx, blocked, challenged, completed, users, pendingUsers, fraudAlerts] = await Promise.all([
    Transaction.countDocuments({}),
    Transaction.countDocuments({ status: 'BLOCKED' }),
    Transaction.countDocuments({ status: 'CHALLENGED' }),
    Transaction.countDocuments({ status: 'COMPLETED' }),
    User.countDocuments({}),
    User.countDocuments({ status: 'PENDING' }),
    Notification.countDocuments({ type: 'FRAUD_ALERT' })
  ]);
  res.json({ totalTx, blocked, challenged, completed, users, pendingUsers, fraudAlerts });
});

/**
 * Live system status for the admin console:
 * data pipeline, fraud model, Kafka and Databricks wiring — one place to see
 * whether every part of the platform is actually up.
 */
router.get('/system', async (_req, res) => {
  const out = {
    time: new Date().toISOString(),
    mongo: { connected: mongoose.connection.readyState === 1 },
    kafka: { enabled: config.kafka.enabled, brokers: config.kafka.brokers },
    databricks: {
      hostConfigured: Boolean(process.env.DATABRICKS_HOST),
      tokenConfigured: Boolean(process.env.DATABRICKS_TOKEN),
      volume: process.env.DATABRICKS_VOLUME_PATH || '/Volumes/fraud/landing/events',
      catalog: process.env.DATABRICKS_CATALOG || 'fraud',
      schema: process.env.DATABRICKS_SCHEMA || 'analytics'
    },
    fraudEngine: { url: config.fraudEngineUrl, reachable: false, mode: 'UNKNOWN', modelLoaded: null, features: null },
    counts: {}
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const r = await fetch(`${config.fraudEngineUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (r.ok) {
      const h = await r.json();
      out.fraudEngine.reachable = true;
      out.fraudEngine.modelLoaded = Boolean(h.model_loaded);
      out.fraudEngine.features = h.features;
      out.fraudEngine.mode = h.model_loaded ? 'ML_MODEL' : 'HEURISTIC';
    }
  } catch { /* engine offline — status stays reachable:false */ }
  try {
    const [users, pendingUsers, activeUsers, blockedUsers, totalTx, blockedTx, challengedTx, fraudAlerts] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ status: 'PENDING' }),
      User.countDocuments({ status: 'ACTIVE' }),
      User.countDocuments({ status: 'BLOCKED' }),
      Transaction.countDocuments({}),
      Transaction.countDocuments({ status: 'BLOCKED' }),
      Transaction.countDocuments({ status: 'CHALLENGED' }),
      Notification.countDocuments({ type: 'FRAUD_ALERT' })
    ]);
    out.counts = { users, pendingUsers, activeUsers, blockedUsers, totalTx, blockedTx, challengedTx, fraudAlerts };
  } catch { /* counts stay empty if the db hiccups */ }
  res.json(out);
});

/**
 * Data-processing monitoring — built ONLY from real system data:
 * - per-hour transaction/decision series from MongoDB (last 24h)
 * - fraud-engine health + mode (ML vs heuristic)
 * - Kafka / Databricks / warehouse configuration state
 * - real Bronze/Silver/Gold counts when a warehouse is configured
 */
router.get('/pipeline', async (_req, res) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    const [series, errors24h, latestErrors] = await Promise.all([
      Transaction.aggregate([
        { $match: { createdAt: { $gte: dayAgo } } },
        { $group: {
          _id: { hour: { $dateTrunc: { date: '$createdAt', unit: 'hour' } } },
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
          challenged: { $sum: { $cond: [{ $eq: ['$status', 'CHALLENGED'] }, 1, 0] } },
          blocked: { $sum: { $cond: [{ $eq: ['$status', 'BLOCKED'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] } },
          fraudScored: { $sum: { $cond: [{ $gt: ['$fraudProbability', 0.3] }, 1, 0] } },
          mlDecisions: { $sum: { $cond: [{ $eq: ['$decisionSource', 'ML_MODEL'] }, 1, 0] } }
        } },
        { $sort: { '_id.hour': 1 } }
      ]),
      Transaction.countDocuments({ createdAt: { $gte: dayAgo }, status: { $in: ['FAILED'] } }),
      Transaction.find({ status: 'FAILED' }).sort({ createdAt: -1 }).limit(10).select('txId status amount reasons createdAt decisionSource').populate('userId', 'email')
    ]);

    let engine = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const r = await fetch(`${config.fraudEngineUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (r.ok) engine = await r.json();
    } catch { /* offline */ }

    const [medallion, snap, lakehouse] = await Promise.all([medallionCounts(), databricksSnapshot(), landingBacklog()]);
    res.json({
      time: new Date().toISOString(),
      series: series.map((s) => ({ hour: s._id.hour, ...s, _id: undefined })),
      totals24h: {
        processed: series.reduce((a, s) => a + s.total, 0),
        completed: series.reduce((a, s) => a + s.completed, 0),
        challenged: series.reduce((a, s) => a + s.challenged, 0),
        blocked: series.reduce((a, s) => a + s.blocked, 0),
        rejected: errors24h,
        mlDecisions: series.reduce((a, s) => a + s.mlDecisions, 0)
      },
      errors: { last24h: errors24h, recent: latestErrors },
      engine,
      kafka: { enabled: config.kafka.enabled, brokers: config.kafka.brokers },
      lakehouse,
      databricks: { ...snap, warehouseConfigured: Boolean(process.env.DATABRICKS_WAREHOUSE_ID), medallionCounts: medallion }
    });
  } catch (err) {
    console.error('[admin] pipeline monitoring failed:', err);
    res.status(500).json({ error: 'Could not load pipeline monitoring data' });
  }
});

/* ===================== Databricks control ===================== */

const requireConfirm = (req, res) => {
  if (req.body?.confirm === true) return true;
  res.status(400).json({ error: 'Confirmation required: this acts on your Databricks workspace and may use compute.' });
  return false;
};

/** Health of every workspace resource (connection, warehouse, catalog, volume, notebooks, jobs). */
router.get('/databricks/status', async (_req, res) => {
  try { res.json(await workspaceStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/** Create/update catalog, schemas, volume, notebooks and jobs. Idempotent. */
router.post('/databricks/provision', async (req, res) => {
  if (!requireConfirm(req, res)) return;
  try {
    const result = await provisionWorkspace();
    console.log(`[admin] databricks provision by ${req.user.email}: ${result.steps.map((s) => `${s.step}=${s.ok ? 'ok' : 'FAIL'}`).join(', ')}`);
    res.status(result.ok ? 200 : 207).json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Run the medallion pipeline job (Bronze → Silver → Gold) now. */
router.post('/databricks/pipeline/run', async (req, res) => {
  if (!requireConfirm(req, res)) return;
  const snap = await databricksSnapshot();
  const job = (snap.jobs || []).find((j) => j.name === JOBS.medallion.name);
  if (!job) return res.status(400).json({ error: `Job "${JOBS.medallion.name}" is not deployed. Use Databricks → Set up / sync first.` });
  if (['PENDING', 'QUEUED', 'RUNNING'].includes(job.latestRun?.state)) return res.status(409).json({ error: `The pipeline is already ${job.latestRun.state}.` });
  const started = await runJob(job.jobId);
  if (!started || started.error || !started.run_id) return res.status(502).json({ error: `Databricks refused the run: ${started?.error || 'no run_id returned'}` });
  invalidateDatabricksCache();
  res.status(202).json({ ok: true, runId: started.run_id, jobId: job.jobId });
});

/* ===================== Lakehouse landing (MongoDB → UC volume) ===================== */

router.get('/lakehouse', async (_req, res) => {
  try { res.json(await landingBacklog()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/lakehouse/land', async (req, res) => {
  try {
    const r = await landTransactions({ triggeredBy: req.user._id });
    if (r.error) return res.status(502).json(r);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ===================== Model training (manual only) ===================== */

export const TRAINING_MODELS = [
  { id: 'logistic_regression', label: 'Logistic Regression', note: 'Linear, fast, easy to explain. Good first baseline.' },
  { id: 'decision_tree', label: 'Decision Tree', note: 'Human-readable if/else rules (depth 6).' },
  { id: 'random_forest', label: 'Random Forest', note: '150 trees; robust on tabular data, slower to train.' },
  { id: 'gradient_boosting', label: 'Gradient Boosting', note: 'Histogram gradient boosting; usually the most accurate.' },
  { id: 'naive_bayes', label: 'Naive Bayes', note: 'Gaussian NB; the simplest probabilistic model.' }
];

async function trainingDatasets() {
  const [mc, bench] = await Promise.all([medallionCounts(), benchmarkStatus()]);
  const silver = mc.silver_events;
  return [
    { id: 'synthetic_payments', label: 'Synthetic payments', rows: 50000, engineCompatible: true, available: true,
      note: 'Seeded generator (50k rows, ~3% fraud). Same features as live payments. No download.' },
    { id: 'platform_transactions', label: 'Platform transactions (lakehouse)', rows: silver, engineCompatible: true,
      available: silver != null && silver >= 50,
      note: silver == null
        ? 'Needs fraud.analytics.silver_events: land transactions, then run the pipeline.'
        : `${silver} rows in silver_events. Labels = blocked or user-reported fraud. Needs ≥ 50 rows and both classes.` },
    (() => {
      const ready = bench.cached || bench.staged;
      return { id: 'creditcard_benchmark', label: 'Credit-card benchmark (public)', rows: null, engineCompatible: false, available: Boolean(ready),
        stageable: true, staged: bench.staged, cached: bench.cached, stageJob: benchmarkStageJob(),
        note: ready
          ? `OpenML 1597 (anonymised PCA features), ${bench.cached ? 'cached as a Delta table' : 'staged in the landing volume'}. For comparison only — its features do not exist in live payments.`
          : bench.staged == null ? 'Could not check the landing volume (Databricks did not answer).'
          : 'OpenML 1597. Databricks serverless has no internet access here, so stage it first: the API downloads it (~73 MB) into the landing volume.' };
    })()
  ];
}

/** Start staging the public benchmark into the UC volume in the background (manual, needs confirm:true). */
router.post('/training/datasets/creditcard_benchmark/stage', async (req, res) => {
  try {
    if (!requireConfirm(req, res)) return;
    const job = startStageBenchmark();
    if (job.error && !job.state) return res.status(400).json(job);
    res.status(202).json(job);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/training/options', async (_req, res) => {
  res.json({ models: TRAINING_MODELS, datasets: await trainingDatasets(), stages: JOBS.training.tasks.map(([k]) => k) });
});

/** Copy real task states (+ notebook outputs of finished tasks) from Databricks onto active runs. */
async function syncTrainingRuns() {
  const active = await TrainingRun.find({ status: { $in: ['QUEUED', 'RUNNING'] } });
  for (const r of active) {
    if (!r.databricksRunId) continue;
    const run = await getRun(r.databricksRunId);
    if (!run || run.error || !run.state) continue;
    const prev = Object.fromEntries((r.stages || []).map((s) => [s.key, s]));
    const stages = [];
    for (const t of latestAttempts(run.tasks).map(taskState)) {
      let output = prev[t.key]?.output ?? null;
      if (!output && t.state === 'TERMINATED' && t.taskRunId) {
        const out = await getRunOutput(t.taskRunId);
        if (out?.notebook_output?.result) {
          try { output = JSON.parse(out.notebook_output.result); } catch { output = { raw: out.notebook_output.result }; }
        } else if (out?.error) output = { error: out.error };
      }
      stages.push({ key: t.key, state: t.state, result: t.result, message: t.message, taskRunId: t.taskRunId, startedAt: t.startedAt, finishedAt: t.finishedAt, output });
    }
    r.stages = stages;
    const lc = run.state.life_cycle_state;
    r.status = lc === 'TERMINATED' || lc === 'INTERNAL_ERROR' || lc === 'SKIPPED'
      ? (run.state.result_state === 'SUCCESS' ? 'COMPLETED' : 'FAILED')
      : lc === 'RUNNING' ? 'RUNNING' : 'QUEUED';
    r.stateMessage = run.state.state_message || run.state.result_state || lc;
    const out = (k) => stages.find((s) => s.key === k)?.output || {};
    const train = out('train_model');
    const evalOut = out('evaluate_register');
    if (train.mlflow_run_id) { r.mlflowRunId = train.mlflow_run_id; r.mlflowExperimentId = train.experiment_id; }
    if (evalOut.metrics) {
      const m = evalOut.metrics;
      r.metrics = { precision: m.precision, recall: m.recall, f1: m.f1, rocAuc: m.roc_auc, prAuc: m.pr_auc, accuracy: m.accuracy };
      const b = evalOut.baseline_metrics;
      r.baselineMetrics = b ? { precision: b.precision, recall: b.recall, f1: b.f1, rocAuc: b.roc_auc, prAuc: b.pr_auc, accuracy: b.accuracy } : undefined;
      r.registeredModel = evalOut.registered_model || undefined;
      r.registeredVersion = evalOut.registered_version || undefined;
    }
    if (r.status === 'COMPLETED' || r.status === 'FAILED') {
      r.finishedAt = run.end_time ? new Date(run.end_time) : new Date();
      const failed = stages.find((s) => s.result && s.result !== 'SUCCESS');
      if (failed) r.stateMessage = `${failed.key} ${failed.result}${failed.output?.error ? `: ${String(failed.output.error).slice(0, 400)}` : ''}`;
      invalidateDatabricksCache();
    }
    r.championModel = r.modelType;
    r.markModified('stages');
    await r.save();
  }
  return active.length;
}

/** Training runs (read-only; syncs live Databricks state first). Never starts anything. */
router.get('/training', async (_req, res) => {
  try { await syncTrainingRuns(); } catch (err) { console.error('[admin] training sync failed:', err.message); }
  const runs = await TrainingRun.find().sort({ createdAt: -1 }).limit(30).populate('triggeredBy', 'email');
  const current = runs[0] ?? null;
  const lastCompleted = runs.find((r) => r.status === 'COMPLETED') ?? null;
  res.json({ runs, current, lastCompleted, stages: JOBS.training.tasks.map(([k]) => k) });
});

/**
 * Manually start one training run on Databricks with the developer's choice of
 * model + dataset. Requires confirm:true. Never called automatically.
 */
router.post('/training/start', async (req, res) => {
  try {
    if (!requireConfirm(req, res)) return;
    const { model, dataset } = req.body;
    if (!TRAINING_MODELS.some((m) => m.id === model)) return res.status(400).json({ error: `Unknown model "${model}".` });
    const ds = (await trainingDatasets()).find((d) => d.id === dataset);
    if (!ds) return res.status(400).json({ error: `Unknown dataset "${dataset}".` });
    if (!ds.available) return res.status(400).json({ error: `Dataset not available yet: ${ds.note}` });

    const active = await TrainingRun.findOne({ status: { $in: ['QUEUED', 'RUNNING'] } });
    if (active) return res.status(409).json({ error: `Training run ${active._id} is already ${active.status}. Wait for it to finish.` });

    const snap = await databricksSnapshot();
    if (!snap.configured) return res.status(400).json({ error: 'Databricks is not configured (set DATABRICKS_HOST and DATABRICKS_TOKEN in .env).' });
    const job = (snap.jobs || []).find((j) => j.name === JOBS.training.name);
    if (!job) return res.status(400).json({ error: `Job "${JOBS.training.name}" is not deployed. Use Databricks → Set up / sync first.` });

    const run = await TrainingRun.create({ status: 'QUEUED', triggeredBy: req.user._id, modelType: model, dataset, databricksJobId: job.jobId, startedAt: new Date() });
    const started = await runJob(job.jobId, { model, dataset, sentinelpay_run_id: String(run._id) });
    if (!started || started.error || !started.run_id) {
      run.status = 'FAILED';
      run.stateMessage = `Databricks refused the run: ${started?.error || 'no run_id returned'}`;
      await run.save();
      return res.status(502).json({ error: run.stateMessage });
    }
    run.databricksRunId = started.run_id;
    await run.save();
    invalidateDatabricksCache();
    res.status(202).json({ ok: true, run, message: 'Training started on Databricks.' });
  } catch (err) {
    console.error('[admin] training start failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Kept for older clients: the sync now also runs inside GET /training.
router.post('/training/sync', async (_req, res) => {
  try { res.json({ ok: true, updated: await syncTrainingRuns() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/** Databricks-hosted MLflow reality check for the Model Training page. */
router.get('/training/mlflow', async (_req, res) => {
  const exps = await listMlflowExperiments();
  const exp = (exps || []).find((e) => (e.name || '').includes('sentinelpay-fraud'));
  const versions = await listModelVersions(REGISTERED_MODEL);
  const modelVersions = (versions || []).map((v) => ({ name: v.name, version: v.version, status: v.status, runId: v.run_id, createdAt: v.creation_timestamp ? new Date(v.creation_timestamp).toISOString() : null }));
  if (!exp) return res.json({ configured: Boolean(exps), experiment: null, runs: [], modelVersions, registeredModel: REGISTERED_MODEL });
  const runs = await listMlflowRuns(exp.experiment_id, 20);
  res.json({
    configured: true,
    registeredModel: REGISTERED_MODEL,
    experiment: { id: exp.experiment_id, name: exp.name, artifactLocation: exp.artifact_location },
    runs: (runs || []).map((r) => ({
      runId: r.info?.run_id, runName: r.info?.run_name, status: r.info?.status,
      startTime: r.info?.start_time ? new Date(Number(r.info.start_time)).toISOString() : null,
      metrics: Object.fromEntries((r.data?.metrics ?? []).map((m) => [m.key, m.value])),
      params: Object.fromEntries((r.data?.params ?? []).map((p) => [p.key, p.value])),
      tags: Object.fromEntries((r.data?.tags ?? []).filter((t) => !t.key.startsWith('mlflow.')).map((t) => [t.key, t.value]))
    })),
    modelVersions
  });
});

export default router;
