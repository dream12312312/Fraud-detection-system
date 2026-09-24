import { Router } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { User, Account, Transaction, Notification, TrainingRun } from '../models.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { config } from '../config.js';
import {
  databricksSnapshot, medallionCounts, listMlflowExperiments, listMlflowRuns,
  runJob, getRun, listModelVersions
} from '../databricksClient.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/users', async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ email: rx }, { fullName: rx }];
  }
  const users = await User.find(q).select('-passwordHash').sort({ createdAt: -1 }).limit(200);
  res.json(users);
});

/** Single user with their accounts + transaction history (user detail view). */
router.get('/users/:id', async (req, res) => {
  const [user, accounts, txns] = await Promise.all([
    User.findById(req.params.id).select('-passwordHash'),
    Account.find({ userId: req.params.id }),
    Transaction.find({ userId: req.params.id }).sort({ createdAt: -1 }).limit(100)
  ]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user, accounts, transactions: txns });
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

    const [medallion, snap] = await Promise.all([medallionCounts(), databricksSnapshot()]);
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
      databricks: { ...snap, warehouseConfigured: Boolean(process.env.DATABRICKS_WAREHOUSE_ID), medallionCounts: medallion }
    });
  } catch (err) {
    console.error('[admin] pipeline monitoring failed:', err);
    res.status(500).json({ error: 'Could not load pipeline monitoring data' });
  }
});

/* ===================== Model training (manual only) ===================== */

const TRAINING_JOB_NAME = 'sentinelpay-model-training';

/**
 * Training state:
 * - current: the latest run record + live Databricks state when available
 * - history: previous runs with metrics from MLflow/this DB
 * Never starts anything by itself — read-only.
 */
router.get('/training', async (_req, res) => {
  const runs = await TrainingRun.find().sort({ createdAt: -1 }).limit(20).populate('triggeredBy', 'email');
  const current = runs[0] ?? null;
  let live = null;
  if (current?.databricksRunId && current.status === 'RUNNING') {
    const r = await getRun(current.databricksRunId);
    if (r && !r.error) {
      live = {
        state: r.state?.life_cycle_state,
        resultState: r.state?.result_state || null,
        stateMessage: r.state?.state_message || null
      };
    }
  }
  // Active model info: last COMPLETED run + current engine mode
  const lastCompleted = runs.find((r) => r.status === 'COMPLETED') ?? null;
  res.json({ runs, current, live, lastCompleted });
});

/**
 * Manually start a model-training run on Databricks.
 * Requires: DATABRICKS_HOST/TOKEN configured and the training job deployed
 * (databricks bundle: sentinelpay-model-training). Never called automatically.
 */
router.post('/training/start', async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'Confirmation required: training runs on Databricks compute and may incur costs.' });
    }
    // An already-running training run blocks a second one.
    const active = await TrainingRun.findOne({ status: { $in: ['QUEUED', 'RUNNING'] } });
    if (active) return res.status(409).json({ error: `Training run ${active._id} is already ${active.status}. Wait for it to finish.` });

    const snap = await databricksSnapshot();
    if (!snap.configured) return res.status(400).json({ error: 'Databricks is not configured (set DATABRICKS_HOST and DATABRICKS_TOKEN in .env).' });
    const job = (snap.jobs || []).find((j) => j.name === TRAINING_JOB_NAME || (j.name || '').includes('model-training'));
    if (!job) return res.status(400).json({ error: `Job "${TRAINING_JOB_NAME}" not found in the workspace. Deploy the bundle first (databricks bundle deploy).` });

    const started = await runJob(job.jobId);
    if (!started || started.error || !started.run_id) {
      return res.status(502).json({ error: `Databricks refused the run: ${started?.error || 'no run_id returned'}` });
    }
    const run = await TrainingRun.create({
      status: 'RUNNING',
      triggeredBy: req.user._id,
      databricksRunId: started.run_id,
      databricksJobId: job.jobId,
      startedAt: new Date()
    });
    res.status(202).json({ ok: true, run, message: 'Training started on Databricks. Track progress on this page and in the Databricks Jobs UI.' });
  } catch (err) {
    console.error('[admin] training start failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Sync the state of RUNNING training runs from Databricks; when a run finished,
 * pull its metrics from the Databricks-hosted MLflow experiment so the numbers
 * displayed here are the real MLflow numbers.
 */
router.post('/training/sync', async (_req, res) => {
  try {
    const active = await TrainingRun.find({ status: 'RUNNING' });
    let changed = false;
    for (const r of active) {
      if (!r.databricksRunId) continue;
      const state = await getRun(r.databricksRunId);
      if (!state || state.error || !state.state) continue;
      const lc = state.state.life_cycle_state;
      if (lc === 'TERMINATED') {
        const result = state.state.result_state;
        r.status = result === 'SUCCESS' ? 'COMPLETED' : 'FAILED';
        r.stateMessage = result;
        r.finishedAt = state.end_time ? new Date(state.end_time) : new Date();
        changed = true;
        if (r.status === 'COMPLETED') {
          // Real metrics come from the Databricks MLflow experiment.
          const exps = await listMlflowExperiments();
          const exp = (exps || []).find((e) => (e.name || '').includes('sentinelpay-fraud'));
          if (exp) {
            r.mlflowExperimentId = exp.experiment_id;
            const mruns = await listMlflowRuns(exp.experiment_id, 5);
            const mrun = (mruns || [])[0];
            if (mrun) {
              r.mlflowRunId = mrun.run_id;
              const m = mrun.data?.metrics ?? {};
              r.metrics = {
                precision: m.precision, recall: m.recall, f1: m.f1,
                rocAuc: m.roc_auc, prAuc: m.pr_auc
              };
              r.championModel = mrun.data?.params?.model ?? undefined;
            }
          }
        }
        await r.save();
      }
    }
    res.json({ ok: true, updated: active.length, changed });
  } catch (err) {
    console.error('[admin] training sync failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/** Databricks-hosted MLflow reality check for the Model Training page. */
router.get('/training/mlflow', async (_req, res) => {
  const exps = await listMlflowExperiments();
  const exp = (exps || []).find((e) => (e.name || '').includes('sentinelpay-fraud'));
  if (!exp) return res.json({ configured: Boolean(exps), experiment: null, runs: [], modelVersions: [] });
  const [runs, versions] = await Promise.all([
    listMlflowRuns(exp.experiment_id, 10),
    listModelVersions(process.env.DATABRICKS_MODEL_NAME || 'sentinelpay-fraud-model')
  ]);
  res.json({
    configured: true,
    experiment: { id: exp.experiment_id, name: exp.name, artifactLocation: exp.artifact_location },
    runs: (runs || []).map((r) => ({
      runId: r.run_id, status: r.info?.status,
      startTime: r.info?.start_time ? new Date(r.info.start_time).toISOString() : null,
      metrics: r.data?.metrics ?? {}, params: r.data?.params ?? {}
    })),
    modelVersions: (versions || []).map((v) => ({ name: v.name, version: v.version, status: v.status, runId: v.run_id, createdAt: v.creation_timestamp ? new Date(v.creation_timestamp).toISOString() : null }))
  });
});

export default router;
