import { Router } from 'express';
import { randomUUID } from 'crypto';
import { User, Account, Beneficiary, Transaction, Notification } from '../models.js';
import { requireAuth } from '../auth.js';
import { scoreTransaction, fallbackRules } from '../fraudClient.js';
import { TOPICS, publish } from '../kafka.js';
import { transactionEvent } from '../lakehouse.js';
import { trackReq } from '../interactions.js';

const router = Router();
router.use(requireAuth);

const newTxId = () => `TX${randomUUID().split('-')[0].toUpperCase()}${Date.now().toString().slice(-4)}`;

function emitTx(req, tx, userId) {
  const io = req.app.get('io');
  if (!io) return;
  const summary = { txId: tx.txId, amount: tx.amount, status: tx.status, fraudProbability: tx.fraudProbability, riskLevel: tx.riskLevel, decision: tx.decision, reasons: tx.reasons, decisionSource: tx.decisionSource, timings: tx.timings };
  io.to(`user:${userId}`).emit('transaction:update', summary);
  io.to('admins').emit('admin:txn', { ...summary, userId: String(userId) });
}

function emitAlert(req, userId, notification) {
  const io = req.app.get('io');
  if (!io) return;
  io.to(`user:${userId}`).emit('notification:new', notification);
  if (notification.type === 'FRAUD_ALERT') io.to('admins').emit('admin:alert', notification);
}

async function notify(req, userId, title, body, type = 'INFO') {
  const n = await Notification.create({ userId, title, body, type });
  emitAlert(req, userId, n);
  return n;
}

router.get('/accounts', async (req, res) => {
  const accounts = await Account.find({ userId: req.user._id });
  res.json(accounts);
});

router.get('/transactions', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const txns = await Transaction.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(limit);
  res.json(txns);
});

router.get('/notifications', async (req, res) => {
  const items = await Notification.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50);
  res.json(items);
});

router.post('/notifications/:id/read', async (req, res) => {
  const n = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { read: true });
  if (n) trackReq(req, { category: 'alert', type: 'alert.read', target: String(n._id), props: { alertType: n.type } });
  res.json({ ok: true });
});

router.get('/beneficiaries', async (req, res) => {
  const items = await Beneficiary.find({ userId: req.user._id }).sort({ createdAt: -1 });
  res.json(items);
});

router.post('/beneficiaries', async (req, res) => {
  const { nickname, accountNumber, bankName } = req.body ?? {};
  if (!nickname || !accountNumber) return res.status(400).json({ error: 'nickname and accountNumber required' });
  const b = await Beneficiary.create({ userId: req.user._id, nickname, accountNumber, bankName });
  await notify(req, req.user._id, 'Beneficiary added', `${nickname} was added to your payees.`, 'INFO');
  trackReq(req, { category: 'beneficiary', type: 'beneficiary.added', target: String(b._id), props: { hasBank: Boolean(bankName) } });
  res.status(201).json(b);
});

/**
 * The behavioural signals the fraud engine is given for a payment. `extra` is a
 * payment that is not stored yet (the preview), so the numbers match what the
 * real /transfer computes after it has created the transaction.
 */
async function riskSignals(user, { toAccount, country, extra }) {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [beneficiary, velocity, agg] = await Promise.all([
    Beneficiary.findOne({ userId: user._id, accountNumber: String(toAccount) }),
    Transaction.countDocuments({ userId: user._id, createdAt: { $gte: hourAgo } }),
    Transaction.aggregate([
      { $match: { userId: user._id, createdAt: { $gte: monthAgo } } },
      { $group: { _id: null, sum: { $sum: '$amount' }, n: { $sum: 1 } } }
    ])
  ]);
  const sum = (agg[0]?.sum || 0) + (extra || 0);
  const n = (agg[0]?.n || 0) + (extra ? 1 : 0);
  const homeCountry = user.homeCountry || 'US';
  return {
    beneficiary,
    features: {
      hourOfDay: new Date().getUTCHours(),
      velocity1h: velocity + (extra ? 1 : 0),
      avgAmount30d: n ? sum / n : extra || 0,
      isNewBeneficiary: !beneficiary,
      homeCountry,
      isForeign: (country || homeCountry) !== homeCountry
    }
  };
}

// Live preview for the Send money form: the signals only, never the score, so the
// form cannot be used to probe where the block threshold is.
router.get('/transfer/signals', async (req, res) => {
  const amt = Number(req.query.amount);
  const { features } = await riskSignals(req.user, { toAccount: req.query.toAccount || '', country: req.query.country, extra: Number.isFinite(amt) && amt > 0 ? amt : 0 });
  res.json({ ...features, amount: Number.isFinite(amt) ? amt : 0 });
});

router.post('/transfer', async (req, res) => {
  const received = performance.now();
  try {
    const { toAccount, amount, merchant, country, device } = req.body ?? {};
    const amt = Number(amount);
    if (!toAccount || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'toAccount and positive amount required' });

    const from = await Account.findOne({ userId: req.user._id, type: 'CHECKING' });
    if (!from) return res.status(400).json({ error: 'No checking account found' });
    if (from.balance - from.heldAmount < amt) return res.status(400).json({ error: 'Insufficient available balance' });

    const tx = await Transaction.create({
      txId: newTxId(),
      userId: req.user._id,
      type: merchant ? 'PAYMENT' : 'TRANSFER',
      amount: amt,
      merchant,
      country: country || req.user.homeCountry || 'US',
      device: device || 'web',
      status: 'PENDING_RISK_CHECK'
    });

    // place a hold so money cannot move before the decision
    from.heldAmount += amt;
    await from.save();

    // ---- fraud scoring (hot path) ----
    // Real behavioral features instead of engine defaults: transactions in the
    // last hour (velocity) and the user's 30-day average amount (both include
    // this payment, which already exists).
    const signals = await riskSignals(req.user, { toAccount, country: tx.country });
    const { beneficiary } = signals;
    const { isForeign, ...features } = signals.features;
    features.hourOfDay = tx.createdAt.getUTCHours();
    features.avgAmount30d = features.avgAmount30d || amt;
    const velocity_1h = features.velocity1h;
    tx.beneficiaryId = beneficiary?._id;
    tx.features = features;
    const scoreStart = performance.now();
    let decision = await scoreTransaction({
      transaction_id: tx.txId,
      user_id: String(req.user._id),
      amount: amt,
      type: tx.type,
      merchant_category: merchant || 'TRANSFER',
      country: tx.country,
      home_country: features.homeCountry,
      is_new_beneficiary: features.isNewBeneficiary,
      channel: 'WEB',
      timestamp: tx.createdAt.toISOString(),
      velocity_1h,
      avg_amount_30d: features.avgAmount30d
    });
    const scoreMs = Math.round(performance.now() - scoreStart);
    if (!decision) {
      decision = fallbackRules({ amount: amt, dailyLimit: from.dailyLimit, isNewBeneficiary: !beneficiary, homeCountry: req.user.homeCountry, country: tx.country });
    }

    tx.fraudProbability = decision.fraudProbability;
    tx.riskLevel = decision.riskLevel;
    tx.decision = decision.decision;
    tx.reasons = decision.reasons;
    tx.modelVersion = decision.modelVersion;
    tx.decisionSource = decision.source;

    const outcome = decision.decision;
    if (outcome === 'BLOCK') {
      tx.status = 'BLOCKED';
      from.heldAmount -= amt; // release hold
      await from.save();
      await notify(req, req.user._id, 'Transaction blocked', `Your transaction ${tx.txId} was blocked because unusual activity was detected.`, 'FRAUD_ALERT');
    } else if (outcome === 'REVIEW') {
      tx.status = 'CHALLENGED';
      await notify(req, req.user._id, 'Confirm this transaction', `Please confirm transaction ${tx.txId} of $${amt.toFixed(2)}.`, 'WARNING');
    } else {
      tx.status = 'COMPLETED';
      from.balance -= amt;
      from.heldAmount -= amt;
      await from.save();
      await notify(req, req.user._id, 'Transaction completed', `${tx.txId}: $${amt.toFixed(2)} sent successfully.`, 'SUCCESS');
    }
    tx.timings = { scoreMs, totalMs: Math.round(performance.now() - received) };
    await tx.save();
    emitTx(req, tx, req.user._id);
    trackReq(req, {
      category: 'payment', type: 'payment.submitted', txId: tx.txId,
      props: { amount: amt, country: tx.country, type: tx.type, status: tx.status, decision: tx.decision, fraudProbability: tx.fraudProbability, reasons: tx.reasons, decisionSource: tx.decisionSource, isNewBeneficiary: features.isNewBeneficiary, velocity1h: features.velocity1h, totalMs: tx.timings.totalMs }
    });

    await publish(TOPICS.raw, tx.txId, transactionEvent(tx, { source: 'kafka' }));
    await publish(TOPICS.status, tx.txId, { event: 'transaction.status', transaction_id: tx.txId, status: tx.status });

    res.status(202).json({ txId: tx.txId, amount: amt, status: tx.status, fraudProbability: tx.fraudProbability, riskLevel: tx.riskLevel, decision: tx.decision, reasons: tx.reasons, source: tx.decisionSource, modelVersion: tx.modelVersion, features, createdAt: tx.createdAt });
  } catch (err) {
    // Full technical detail goes to server logs; the user only ever sees a
    // friendly message (never a raw Mongoose/Mongo validation dump).
    console.error('[banking] transfer failed:', err);
    const technical = err.name === 'ValidationError' || err.name === 'MongoServerError' || err.name === 'CastError';
    res.status(500).json({ error: technical
      ? 'We could not process this payment right now. Please try again in a moment.'
      : (err.message || 'Unexpected error while processing the payment.') });
  }
});

router.post('/transactions/:txId/confirm', async (req, res) => {
  const tx = await Transaction.findOne({ txId: req.params.txId, userId: req.user._id });
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (tx.status !== 'CHALLENGED') return res.status(400).json({ error: `Cannot confirm transaction in status ${tx.status}` });
  const from = await Account.findOne({ userId: req.user._id, type: 'CHECKING' });
  // The hold is already reserved in heldAmount; completing must debit the real
  // balance. If the money is gone (e.g. another confirmed payment first), the
  // transaction fails instead of driving the account negative.
  if (!from || from.balance < tx.amount) {
    tx.status = 'FAILED';
    if (from) { from.heldAmount = Math.max(0, from.heldAmount - tx.amount); await from.save(); }
    await tx.save();
    await notify(req, req.user._id, 'Payment failed', `${tx.txId} could not be completed: insufficient balance.`, 'WARNING');
    trackReq(req, { category: 'decision', type: 'decision.confirmed', txId: tx.txId, label: 'legit', props: { amount: tx.amount, fraudProbability: tx.fraudProbability, reasons: tx.reasons, result: 'FAILED_INSUFFICIENT_BALANCE' } });
    return res.json({ txId: tx.txId, status: tx.status });
  }
  from.balance -= tx.amount;
  from.heldAmount = Math.max(0, from.heldAmount - tx.amount);
  await from.save();
  tx.status = 'COMPLETED'; await tx.save();
  await notify(req, req.user._id, 'Transaction confirmed', `${tx.txId} completed after your confirmation.`, 'SUCCESS');
  // the customer says "this was me": a real 'legit' label for a flagged payment
  trackReq(req, { category: 'decision', type: 'decision.confirmed', txId: tx.txId, label: 'legit', props: { amount: tx.amount, fraudProbability: tx.fraudProbability, reasons: tx.reasons, secondsToAnswer: Math.round((Date.now() - tx.createdAt) / 1000), result: 'COMPLETED' } });
  res.json({ txId: tx.txId, amount: tx.amount, status: tx.status });
});

router.post('/transactions/:txId/report', async (req, res) => {
  const tx = await Transaction.findOne({ txId: req.params.txId, userId: req.user._id });
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  // only a payment still waiting on the customer can be reported; a settled one
  // (e.g. already approved by the fraud team) has moved money and keeps no hold
  if (tx.status !== 'CHALLENGED') return res.status(400).json({ error: `This payment was already settled (${tx.status}), so it can no longer be reported here.` });
  tx.status = 'BLOCKED';
  tx.reasons = [...(tx.reasons || []), 'USER_REPORTED_FRAUD'];
  await tx.save();
  const from = await Account.findOne({ userId: req.user._id, type: 'CHECKING' });
  if (from) { from.heldAmount = Math.max(0, from.heldAmount - tx.amount); await from.save(); }
  await notify(req, req.user._id, 'Fraud reported', `Transaction ${tx.txId} was blocked. Our team will contact you.`, 'FRAUD_ALERT');
  // the customer says "this was not me": a real 'fraud' label
  trackReq(req, { category: 'decision', type: 'decision.reported', txId: tx.txId, label: 'fraud', props: { amount: tx.amount, fraudProbability: tx.fraudProbability, reasons: tx.reasons, secondsToAnswer: Math.round((Date.now() - tx.createdAt) / 1000) } });
  res.json({ txId: tx.txId, status: tx.status });
});

export default router;
