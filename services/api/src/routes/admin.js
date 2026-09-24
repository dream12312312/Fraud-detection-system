import { Router } from 'express';
import { User, Account, Transaction, Notification } from '../models.js';
import { requireAuth, requireAdmin } from '../auth.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/users', async (_req, res) => {
  const users = await User.find().select('-passwordHash').sort({ createdAt: -1 });
  res.json(users);
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

router.get('/transactions', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const q = {};
  if (req.query.status) q.status = req.query.status;
  const txns = await Transaction.find(q).sort({ createdAt: -1 }).limit(limit).populate('userId', 'fullName email');
  res.json(txns);
});

router.get('/stats', async (_req, res) => {
  const [totalTx, blocked, challenged, completed, users, fraudAlerts] = await Promise.all([
    Transaction.countDocuments({}),
    Transaction.countDocuments({ status: 'BLOCKED' }),
    Transaction.countDocuments({ status: 'CHALLENGED' }),
    Transaction.countDocuments({ status: 'COMPLETED' }),
    User.countDocuments({}),
    Notification.countDocuments({ type: 'FRAUD_ALERT' })
  ]);
  res.json({ totalTx, blocked, challenged, completed, users, fraudAlerts });
});

export default router;
