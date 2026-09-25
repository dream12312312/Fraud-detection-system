import { Router } from 'express';
import { User } from '../models.js';
import { requireAuth, requireAdmin } from '../auth.js';
import {
  track, trackReq, interactionModel, interactionsReady, interactionsInfo, interactionsDb, CATEGORIES
} from '../interactions.js';

/* ======================= client events (both apps) ======================= */

const router = Router();
router.use(requireAuth);

// Clients may only report what the server cannot see itself: page views and UI
// clicks. Payments, answers and sign-ins are recorded server-side, so a client
// cannot forge them.
const CLIENT_TYPE = /^(page|ui)\.[a-z0-9_.-]{1,40}$/;
const MAX_BATCH = 50;
const PER_MINUTE = 300;
const budget = new Map(); // userId -> { minute, used }

router.post('/', (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, MAX_BATCH) : [];
  const app = req.body?.app === 'admin-app' && req.user.role === 'admin' ? 'admin-app' : 'user-app';
  const key = String(req.user._id);
  const minute = Math.floor(Date.now() / 60000);
  const b = budget.get(key)?.minute === minute ? budget.get(key) : { minute, used: 0 };
  budget.set(key, b);

  let accepted = 0;
  const now = Date.now();
  for (const e of events) {
    if (b.used >= PER_MINUTE) break;
    if (!e || typeof e.type !== 'string' || !CLIENT_TYPE.test(e.type)) continue;
    const t = new Date(e.ts).getTime();
    b.used += 1; accepted += 1;
    trackReq(req, {
      source: 'client', app,
      category: e.type.startsWith('page.') ? 'navigation' : 'ui',
      type: e.type,
      target: e.target,
      txId: e.txId,
      sessionId: e.sessionId || req.get('x-session-id'),
      // client clocks drift: keep their time only when it is plausible
      ts: Number.isFinite(t) && t > now - 3600e3 && t < now + 60e3 ? new Date(t) : new Date(now),
      props: e.props
    });
  }
  res.status(202).json({ accepted, dropped: events.length - accepted, stored: interactionsReady() });
});

export default router;

/* ============================ admin management ============================ */

export const adminInteractionRoutes = Router();
adminInteractionRoutes.use(requireAuth, requireAdmin);

const unavailable = (res) => res.status(503).json({ error: 'The interaction database is not connected. Check INTERACTIONS_MONGODB_URI / MongoDB and restart the API.' });

function filterFrom(q) {
  const f = {};
  if (q.category && CATEGORIES.includes(q.category)) f.category = q.category;
  if (q.type) f.type = String(q.type);
  if (q.userId) f.userId = String(q.userId);
  if (q.txId) f.txId = String(q.txId);
  if (q.source === 'server' || q.source === 'client') f.source = q.source;
  if (q.label === 'legit' || q.label === 'fraud') f.label = q.label;
  if (q.label === 'any') f.label = { $in: ['legit', 'fraud'] };
  const ts = {};
  if (q.from && !Number.isNaN(Date.parse(q.from))) ts.$gte = new Date(q.from);
  if (q.to && !Number.isNaN(Date.parse(q.to))) ts.$lte = new Date(q.to);
  if (q.before && !Number.isNaN(Date.parse(q.before))) ts.$lt = new Date(q.before);
  if (Object.keys(ts).length) f.ts = ts;
  return f;
}

async function emails(ids) {
  const valid = [...new Set(ids.filter((x) => /^[a-f0-9]{24}$/i.test(x || '')))];
  if (!valid.length) return {};
  const users = await User.find({ _id: { $in: valid } }).select('email');
  return Object.fromEntries(users.map((u) => [String(u._id), u.email]));
}

/** Totals, breakdowns and a 14-day series for the admin page. */
adminInteractionRoutes.get('/stats', async (_req, res) => {
  const info = interactionsInfo();
  if (!interactionsReady()) return res.json({ store: info, total: 0 });
  const I = interactionModel();
  const since = new Date(Date.now() - 14 * 86400e3);
  try {
    const [total, users, byCategory, byType, perDay, labels, bounds, size, topUsers] = await Promise.all([
      I.estimatedDocumentCount(),
      I.distinct('userId', { userId: { $ne: null } }).then((x) => x.length),
      I.aggregate([{ $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      I.aggregate([{ $group: { _id: '$type', n: { $sum: 1 }, category: { $first: '$category' } } }, { $sort: { n: -1 } }, { $limit: 25 }]),
      I.aggregate([
        { $match: { ts: { $gte: since } } },
        { $group: { _id: { d: { $dateTrunc: { date: '$ts', unit: 'day' } }, c: '$category' }, n: { $sum: 1 } } },
        { $sort: { '_id.d': 1 } }
      ]),
      I.aggregate([{ $match: { label: { $in: ['legit', 'fraud'] } } }, { $group: { _id: '$label', n: { $sum: 1 } } }]),
      Promise.all([I.findOne().sort({ ts: 1 }).select('ts'), I.findOne().sort({ ts: -1 }).select('ts')]),
      interactionsDb().stats().catch(() => null),
      I.aggregate([{ $match: { userId: { $ne: null } } }, { $group: { _id: '$userId', n: { $sum: 1 }, last: { $max: '$ts' } } }, { $sort: { n: -1 } }, { $limit: 6 }])
    ]);
    const mail = await emails(topUsers.map((u) => u._id));
    res.json({
      store: info,
      total, users,
      byCategory: byCategory.map((c) => ({ category: c._id, n: c.n })),
      byType: byType.map((t) => ({ type: t._id, category: t.category, n: t.n })),
      perDay: perDay.map((p) => ({ day: p._id.d, category: p._id.c, n: p.n })),
      labels: Object.fromEntries(labels.map((l) => [l._id, l.n])),
      oldest: bounds[0]?.ts || null, newest: bounds[1]?.ts || null,
      size: size ? { dataBytes: size.dataSize, storageBytes: size.storageSize, indexBytes: size.indexSize } : null,
      topUsers: topUsers.map((u) => ({ userId: u._id, email: mail[u._id] || null, n: u.n, last: u.last }))
    });
  } catch (err) {
    console.error('[interactions] stats failed:', err);
    res.status(500).json({ error: 'Could not read the interaction database.' });
  }
});

/** Newest-first page of events, with filters and a `before` cursor. */
adminInteractionRoutes.get('/', async (req, res) => {
  if (!interactionsReady()) return unavailable(res);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const items = await interactionModel().find(filterFrom(req.query)).sort({ ts: -1 }).limit(limit + 1).lean();
  const more = items.length > limit;
  const page = items.slice(0, limit);
  const mail = await emails(page.map((i) => i.userId));
  res.json({
    items: page.map((i) => ({ ...i, email: mail[i.userId] || null })),
    nextBefore: more ? page[page.length - 1].ts : null
  });
});

const CSV_COLS = ['ts', 'source', 'app', 'category', 'type', 'userId', 'role', 'sessionId', 'target', 'txId', 'label', 'props'];
const csvCell = (v) => {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** Download matching events as CSV or JSON Lines (max 100 000 rows), streamed. */
adminInteractionRoutes.get('/export', async (req, res) => {
  if (!interactionsReady()) return unavailable(res);
  const format = req.query.format === 'csv' ? 'csv' : 'jsonl';
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="interactions-${stamp}.${format}"`);
  if (format === 'csv') res.write(`${CSV_COLS.join(',')}\n`);
  let n = 0;
  const cursor = interactionModel().find(filterFrom(req.query)).sort({ ts: -1 }).limit(100000).lean().cursor();
  for await (const doc of cursor) {
    n += 1;
    const { _id, ...row } = doc;
    res.write(format === 'csv' ? `${CSV_COLS.map((c) => csvCell(row[c])).join(',')}\n` : `${JSON.stringify({ id: String(_id), ...row })}\n`);
  }
  res.end();
  trackReq(req, { category: 'admin', type: 'admin.interactions_exported', props: { format, rows: n } });
});

/**
 * Retention / right to be forgotten. Needs confirm:true and at least one scope:
 * olderThanDays, userId, or all:true.
 */
adminInteractionRoutes.delete('/', async (req, res) => {
  if (!interactionsReady()) return unavailable(res);
  const { confirm, olderThanDays, userId, all } = req.body ?? {};
  if (confirm !== true) return res.status(400).json({ error: 'Confirmation required: this permanently deletes interaction events.' });
  const f = {};
  const days = Number(olderThanDays);
  if (olderThanDays != null) {
    if (!Number.isFinite(days) || days < 1) return res.status(400).json({ error: 'olderThanDays must be 1 or more.' });
    f.ts = { $lt: new Date(Date.now() - days * 86400e3) };
  }
  if (userId) f.userId = String(userId);
  if (!Object.keys(f).length && all !== true) return res.status(400).json({ error: 'Say what to delete: olderThanDays, userId, or all:true.' });
  const r = await interactionModel().deleteMany(f);
  trackReq(req, { category: 'admin', type: 'admin.interactions_deleted', props: { deleted: r.deletedCount, olderThanDays: olderThanDays ?? null, userId: userId || null, all: all === true } });
  res.json({ deleted: r.deletedCount });
});

export { track };
