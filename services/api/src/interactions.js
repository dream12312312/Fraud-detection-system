import mongoose from 'mongoose';
import { config } from './config.js';

/**
 * Interaction store: a SEPARATE MongoDB database that records what people do
 * in the product (sign-ins, payments, answers to flagged payments, page views,
 * admin actions). It is kept apart from the banking database so it can grow,
 * be exported, be wiped or be moved to another server without touching money.
 *
 * Rules:
 * - Writing never blocks or breaks a request: track() is fire-and-forget.
 * - No secrets: keys that look like passwords/tokens are dropped, strings are
 *   truncated and only flat primitive values are kept.
 * - Customer answers ("confirmed" / "reported") are stored with a `label`, so
 *   they can later be joined with the lakehouse and used as training labels.
 */

const DB_NAME = 'sentinelpay_interactions';

/** Same server as the banking DB, different database — unless INTERACTIONS_MONGODB_URI says otherwise. */
export function interactionsUri() {
  if (config.interactionsMongoUri) return config.interactionsMongoUri;
  try {
    const u = new URL(config.mongoUri);
    u.pathname = `/${DB_NAME}`;
    return u.toString();
  } catch {
    return `mongodb://localhost:27017/${DB_NAME}`;
  }
}

export const CATEGORIES = ['auth', 'payment', 'decision', 'beneficiary', 'alert', 'navigation', 'ui', 'admin'];

const InteractionSchema = new mongoose.Schema({
  ts: { type: Date, default: Date.now },
  source: { type: String, enum: ['server', 'client'], required: true },
  app: { type: String, enum: ['user-app', 'admin-app', 'api'], default: 'api' },
  category: { type: String, enum: CATEGORIES, required: true },
  type: { type: String, required: true },
  userId: String,
  role: { type: String, enum: ['user', 'admin', 'anonymous'], default: 'user' },
  sessionId: String,
  target: String,
  txId: String,
  label: { type: String, enum: ['legit', 'fraud', null], default: null },
  props: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { versionKey: false, minimize: true });
InteractionSchema.index({ ts: -1 });
InteractionSchema.index({ userId: 1, ts: -1 });
InteractionSchema.index({ type: 1, ts: -1 });
InteractionSchema.index({ category: 1, ts: -1 });
InteractionSchema.index({ txId: 1 }, { sparse: true });
InteractionSchema.index({ label: 1 }, { sparse: true });

let conn = null;
let Interaction = null;
const counters = { written: 0, dropped: 0, lastError: null };

export async function connectInteractions() {
  const uri = interactionsUri();
  conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 4000 });
  Interaction = conn.model('Interaction', InteractionSchema, 'interactions');
  conn.on('error', (err) => { counters.lastError = err.message; });
  try {
    await conn.asPromise();
    await Interaction.syncIndexes();
    console.log(`[interactions] connected to database "${conn.name}"`);
  } catch (err) {
    counters.lastError = err.message;
    console.error('[interactions] store unavailable, events will be dropped:', err.message);
  }
  return conn;
}

export const interactionModel = () => Interaction;
export const interactionsReady = () => conn?.readyState === 1;
export const interactionsInfo = () => ({ database: conn?.name || DB_NAME, connected: interactionsReady(), ...counters });
export const interactionsDb = () => conn?.db;

const SECRET_KEY = /pass|token|secret|authorization|cookie|otp|pin|cvv|card/i;

/** Keep only small, flat, non-secret values. */
export function cleanProps(props) {
  const out = {};
  if (!props || typeof props !== 'object') return out;
  for (const [k, v] of Object.entries(props).slice(0, 20)) {
    if (SECRET_KEY.test(k) || k.length > 40) continue;
    if (v == null) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x) => ['string', 'number', 'boolean'].includes(typeof x)).slice(0, 10).map((x) => (typeof x === 'string' ? x.slice(0, 60) : x));
  }
  return out;
}

/** Record one event. Never throws, never awaits in the caller's path. */
export function track(evt) {
  if (!interactionsReady()) { counters.dropped += 1; return; }
  const doc = {
    ts: evt.ts || new Date(),
    source: evt.source || 'server',
    app: evt.app || 'api',
    category: evt.category,
    type: String(evt.type).slice(0, 60),
    userId: evt.userId ? String(evt.userId) : undefined,
    role: evt.role || (evt.userId ? 'user' : 'anonymous'),
    sessionId: evt.sessionId ? String(evt.sessionId).slice(0, 64) : undefined,
    target: evt.target ? String(evt.target).slice(0, 120) : undefined,
    txId: evt.txId ? String(evt.txId).slice(0, 40) : undefined,
    label: evt.label || null,
    props: cleanProps(evt.props)
  };
  Interaction.create(doc).then(
    () => { counters.written += 1; },
    (err) => { counters.dropped += 1; counters.lastError = err.message; }
  );
}

/** Convenience for route handlers: fills user, role and session from the request. */
export function trackReq(req, evt) {
  track({
    userId: req.user?._id,
    role: req.user ? (req.user.role === 'admin' ? 'admin' : 'user') : 'anonymous',
    sessionId: req.get?.('x-session-id'),
    ...evt
  });
}
