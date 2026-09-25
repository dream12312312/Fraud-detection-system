import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;

const UserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, index: true },
  passwordHash: { type: String, required: true },
  // Set when an admin assigns a temporary password; the user must change it
  // before anything else in the app is usable.
  mustChangePassword: { type: Boolean, default: false },
  fullName: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  status: { type: String, enum: ['PENDING', 'ACTIVE', 'DISABLED', 'BLOCKED'], default: 'PENDING' },
  homeCountry: { type: String, default: 'US' },
  phone: String,
  createdAt: { type: Date, default: Date.now }
});

const AccountSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
  accountNumber: { type: String, required: true, unique: true },
  type: { type: String, enum: ['CHECKING', 'SAVINGS'], default: 'CHECKING' },
  currency: { type: String, default: 'USD' },
  balance: { type: Number, default: 0 },
  heldAmount: { type: Number, default: 0 },
  dailyLimit: { type: Number, default: 10000 }
});

const BeneficiarySchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
  nickname: { type: String, required: true },
  accountNumber: { type: String, required: true },
  bankName: String,
  verified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const TransactionSchema = new Schema({
  txId: { type: String, required: true, unique: true },
  userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['TRANSFER', 'PAYMENT', 'DEPOSIT', 'WITHDRAWAL'], required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
  merchant: String,
  beneficiaryId: Types.ObjectId,
  country: { type: String, default: 'US' },
  device: String,
  status: {
    type: String,
    enum: ['PENDING_RISK_CHECK', 'COMPLETED', 'CHALLENGED', 'BLOCKED', 'FAILED', 'EXPIRED'],
    default: 'PENDING_RISK_CHECK',
    index: true
  },
  fraudProbability: Number,
  riskLevel: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', null] },
  decision: { type: String, enum: ['APPROVE', 'REVIEW', 'BLOCK', null] },
  reasons: [String],
  modelVersion: String,
  decisionSource: { type: String, enum: ['ML_MODEL', 'RULES_FALLBACK', 'ADMIN', 'HEURISTIC', null] },
  // Snapshot of the real-time features the fraud engine scored (ML lineage:
  // the same values land in the lakehouse and become training data).
  features: {
    hourOfDay: Number, velocity1h: Number, avgAmount30d: Number,
    isNewBeneficiary: Boolean, homeCountry: String
  },
  // Admin balance adjustments are ledger entries, never fraud-scored.
  adminNote: String,
  // Set when the transaction was exported to the Databricks landing volume.
  lakeLandedAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
});

/** One file exported from MongoDB to the Databricks landing volume. */
const LakeBatchSchema = new Schema({
  path: String,
  rows: Number,
  bytes: Number,
  trigger: { type: String, enum: ['MANUAL', 'KAFKA_BRIDGE'], default: 'MANUAL' },
  triggeredBy: { type: Types.ObjectId, ref: 'User' },
  error: String,
  createdAt: { type: Date, default: Date.now, index: true }
});
export const LakeBatch = model('LakeBatch', LakeBatchSchema);

const NotificationSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true },
  body: String,
  type: { type: String, enum: ['INFO', 'WARNING', 'FRAUD_ALERT', 'SUCCESS'], default: 'INFO' },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

/**
 * Manual model-training runs triggered from the admin console.
 * States: QUEUED -> RUNNING -> COMPLETED | FAILED. Never started automatically.
 */
const TrainingRunSchema = new Schema({
  status: { type: String, enum: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'], default: 'QUEUED', index: true },
  triggeredBy: { type: Types.ObjectId, ref: 'User' },
  databricksRunId: Number,
  databricksJobId: Number,
  stateMessage: String,
  metrics: {
    precision: Number, recall: Number, f1: Number, rocAuc: Number, prAuc: Number, accuracy: Number
  },
  // Same test set scored by the base (rule-based) model, for comparison.
  baselineMetrics: {
    precision: Number, recall: Number, f1: Number, rocAuc: Number, prAuc: Number, accuracy: Number
  },
  modelType: String, // chosen by the developer, e.g. logistic_regression
  dataset: String, // chosen by the developer, e.g. synthetic_payments
  // Per-stage state copied from the Databricks job's task runs (never invented).
  stages: [{
    key: String, state: String, result: String, message: String, taskRunId: Number,
    startedAt: Date, finishedAt: Date, output: Schema.Types.Mixed
  }],
  registeredModel: String,
  registeredVersion: String,
  championModel: String,
  mlflowRunId: String,
  mlflowExperimentId: String,
  startedAt: Date,
  finishedAt: Date,
  createdAt: { type: Date, default: Date.now, index: true }
});

export const TrainingRun = model('TrainingRun', TrainingRunSchema);

const ApiLogSchema = new Schema({
  method: String, path: String, status: Number, latencyMs: Number,
  userId: Types.ObjectId, requestId: String, createdAt: { type: Date, default: Date.now }
});
ApiLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

export const User = model('User', UserSchema);
export const Account = model('Account', AccountSchema);
export const Beneficiary = model('Beneficiary', BeneficiarySchema);
export const Transaction = model('Transaction', TransactionSchema);
export const Notification = model('Notification', NotificationSchema);
export const ApiLog = model('ApiLog', ApiLogSchema);

export async function connectDb(uri) {
  await mongoose.connect(uri);
  return mongoose.connection;
}
