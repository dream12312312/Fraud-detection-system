import { Router } from 'express';
import { randomUUID } from 'crypto';
import { User, Account, Beneficiary, Transaction, Notification } from '../models.js';
import { requireAuth } from '../auth.js';
import { scoreTransaction, fallbackRules } from '../fraudClient.js';
import { TOPICS, publish } from '../kafka.js';
import { transactionEvent } from '../lakehouse.js';

const router = Router();
router.use(requireAuth);

const newTxId = () => `TX${randomUUID().split('-')[0].toUpperCase()}${Date.now().toString().slice(-4)}`;

function emitTx(req, tx, userId) {
  const io = req.app.get('io');
  if (!io) return;
  const summary = { txId: tx.txId, amount: tx.amount, status: tx.status, fraudProbability: tx.fraudProbability, riskLevel: tx.riskLevel, decision: tx.decision, reasons: tx.reasons };
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
  await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { read: true });
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
  res.status(201).json(b);
});

router.post('/transfer', async (req, res) => {
  try {
    const { toAccount, amount, merchant, country, device } = req.body ?? {};
    const amt = Number(amount);
    if (!toAccount || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'toAccount and positive amount required' });

    const from = await Account.findOne({ userId: req.user._id, type: 'CHECKING' });
    if (!from) return res.status(400).json({ error: 'No checking account found' });
    if (from.balance - from.heldAmount < amt) return res.status(400).json({ error: 'Insufficient available balance' });

    const beneficiary = await Beneficiary.findOne({ userId: req.user._id, accountNumber: String(toAccount) });
    const tx = await Transaction.create({
      txId: newTxId(),
      userId: req.user._id,
      type: merchant ? 'PAYMENT' : 'TRANSFER',
      amount: amt,
      merchant,
      beneficiaryId: beneficiary?._id,
      country: country || req.user.homeCountry || 'US',
      device: device || 'web',
      status: 'PENDING_RISK_CHECK'
    });

    // place a hold so money cannot move before the decision
    from.heldAmount += amt;
    await from.save();

    // ---- fraud scoring (hot path) ----
    // Real behavioral features instead of engine defaults: transactions in the
    // last hour (velocity) and the user's 30-day average amount.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [velocity_1h, avgAgg] = await Promise.all([
      Transaction.countDocuments({ userId: req.user._id, createdAt: { $gte: hourAgo } }),
      Transaction.aggregate([
        { $match: { userId: req.user._id, createdAt: { $gte: monthAgo } } },
        { $group: { _id: null, avg: { $avg: '$amount' } } }
      ])
    ]);
    const features = {
      hourOfDay: tx.createdAt.getUTCHours(),
      velocity1h: velocity_1h,
      avgAmount30d: avgAgg[0]?.avg || amt,
      isNewBeneficiary: !beneficiary,
      homeCountry: req.user.homeCountry || 'US'
    };
    tx.features = features;
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
    await tx.save();
    emitTx(req, tx, req.user._id);

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
    return res.json({ txId: tx.txId, status: tx.status });
  }
  from.balance -= tx.amount;
  from.heldAmount = Math.max(0, from.heldAmount - tx.amount);
  await from.save();
  tx.status = 'COMPLETED'; await tx.save();
  await notify(req, req.user._id, 'Transaction confirmed', `${tx.txId} completed after your confirmation.`, 'SUCCESS');
  res.json({ txId: tx.txId, amount: tx.amount, status: tx.status });
});

router.post('/transactions/:txId/report', async (req, res) => {
  const tx = await Transaction.findOne({ txId: req.params.txId, userId: req.user._id });
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  tx.status = 'BLOCKED';
  tx.reasons = [...(tx.reasons || []), 'USER_REPORTED_FRAUD'];
  await tx.save();
  const from = await Account.findOne({ userId: req.user._id, type: 'CHECKING' });
  if (from) { from.heldAmount = Math.max(0, from.heldAmount - tx.amount); await from.save(); }
  await notify(req, req.user._id, 'Fraud reported', `Transaction ${tx.txId} was blocked. Our team will contact you.`, 'FRAUD_ALERT');
  res.json({ txId: tx.txId, status: tx.status });
});

export default router;
