/**
 * SentinelPay architecture model for the 3D / 2D views.
 *
 * Every status is derived from real API responses:
 *   /admin/system, /admin/pipeline (incl. Databricks job task states + row counts),
 *   /admin/training (task states of the training job), /admin/training/mlflow, /admin/stats
 * When a signal does not exist the node says so instead of guessing.
 *
 * Layout: three lanes read like a circuit board.
 *   A  real-time serving      left → right   (milliseconds)
 *   B  ingestion + lakehouse  left → right   (minutes)
 *   C  machine learning       right → left   (feedback loop back to the fraud engine)
 * x = order along the flow, z = lane; the Databricks platform sits under B/C's right side.
 */

export const STATUS = {
  green: { label: 'Healthy', color: '#34d399' },
  blue: { label: 'Running', color: '#60a5fa' },
  yellow: { label: 'Warning / waiting', color: '#fbbf24' },
  red: { label: 'Failed / error', color: '#f87171' },
  gray: { label: 'Inactive / not set up', color: '#64748b' }
};

export const LAYERS = {
  client: { label: 'Application', color: '#4f7cff' },
  backend: { label: 'Backend service', color: '#8b5cf6' },
  database: { label: 'Operational database', color: '#22c55e' },
  streaming: { label: 'Ingestion', color: '#f97316' },
  databricks: { label: 'Databricks lakehouse', color: '#ff3621' },
  ml: { label: 'Machine learning', color: '#eab308' },
  monitoring: { label: 'Monitoring', color: '#06b6d4' }
};

// `tag` places each lane's title in empty floor space next to the lane.
export const LANES = [
  { id: 'hot', label: 'Real-time serving', sub: 'milliseconds · every payment', z: -7, color: '#4f7cff', dir: 1, tag: { x: 5.7, align: 'left' } },
  { id: 'cold', label: 'Ingestion & lakehouse', sub: 'minutes · batch', z: 0, color: '#f97316', dir: 1, tag: { x: -11.2, align: 'right' } },
  { id: 'train', label: 'Machine learning loop', sub: 'on demand · manual', z: 7, color: '#eab308', dir: -1, tag: { x: -2.2, align: 'right' } }
];

// Databricks platform footprint on the floor: [xMin, xMax, zMin, zMax]
export const PLATFORM = [-2.1, 14.4, -2.6, 11.8];

// Labels of alternating neighbours are lifted so they never sit on top of each other.
const LAYOUT = {
  'user-app': { pos: [-14, 0, -7], lane: 'hot', step: 1 },
  api: { pos: [-9.5, 0, -7], lane: 'hot', step: 2, lift: 1 },
  'fraud-engine': { pos: [-5, 0, -7], lane: 'hot', step: 3 },
  alerts: { pos: [-0.5, 0, -7], lane: 'hot', step: 4, lift: 1 },

  mongo: { pos: [-9.5, 0, 0], lane: 'cold', step: 1 },
  landing: { pos: [-5.2, 0, -0.8], lane: 'cold', step: 2, lift: 1 },
  kafka: { pos: [-7.6, 0, 3], lane: 'cold', step: '2b' },
  bridge: { pos: [-3.6, 0, 3], lane: 'cold', step: '2c' },
  volume: { pos: [0, 0, 0], lane: 'cold', step: 3 },
  bronze: { pos: [3.7, 0, 0], lane: 'cold', step: 4, lift: 1 },
  silver: { pos: [7.4, 0, 0], lane: 'cold', step: 5 },
  gold: { pos: [11.1, 0, 0], lane: 'cold', step: 6, lift: 1 },

  dataset: { pos: [12.4, 0, 7], lane: 'train', step: 1 },
  features: { pos: [9.2, 0, 7], lane: 'train', step: 2, lift: 1 },
  train: { pos: [6, 0, 7], lane: 'train', step: 3 },
  evaluate: { pos: [2.8, 0, 7], lane: 'train', step: 4, lift: 1 },
  mlflow: { pos: [4.4, 0, 10.4], lane: 'train', step: '3b' },
  registry: { pos: [-0.4, 0, 7], lane: 'train', step: 5 }
};

const CHECKING = 'CHECKING…';
const n = (v) => (v == null ? null : Number(v));
const fmtInt = (v) => (v == null ? 'n/a' : Number(v).toLocaleString());
const fmtMetric = (v) => (v == null ? '—' : Number(v).toFixed(3));
const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleString();
};
const secs = (a, b) => (a ? `${Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 1000)}s` : '—');

/** Status of one Databricks task run (from the Jobs API). */
export function taskStatus(t, fallbackLabel = 'NOT RUN YET') {
  if (!t) return { status: 'gray', label: fallbackLabel };
  if (t.result === 'SUCCESS') return { status: 'green', label: 'SUCCEEDED' };
  if (t.result) return { status: 'red', label: t.result };
  if (t.state === 'RUNNING' || t.state === 'PENDING') return { status: 'blue', label: t.state };
  if (t.state === 'QUEUED' || t.state === 'BLOCKED') return { status: 'yellow', label: t.state === 'BLOCKED' ? 'WAITING FOR PREVIOUS STAGE' : 'QUEUED' };
  return { status: 'gray', label: t.state || fallbackLabel };
}

export function buildArchitecture({ system, pipeline, training, mlflow, stats, flow, apiOnline }) {
  const db = pipeline?.databricks ?? {};
  const host = db.host || null;
  const jobs = db.jobs || [];
  const medJob = jobs.find((j) => (j.name || '').includes('medallion'));
  const trainJob = jobs.find((j) => (j.name || '').includes('model-training'));
  const medTasks = Object.fromEntries((medJob?.latestRun?.tasks || []).map((t) => [t.key, t]));
  const mc = db.medallionCounts ?? {};
  const lake = pipeline?.lakehouse ?? null;
  const kafkaOn = Boolean(system?.kafka?.enabled);
  const dbxConfigured = Boolean(system?.databricks?.hostConfigured && system?.databricks?.tokenConfigured);
  const fe = system?.fraudEngine ?? {};
  const cur = training?.current ?? null;
  const last = training?.lastCompleted ?? null;
  const trainingActive = cur?.status === 'RUNNING' || cur?.status === 'QUEUED';
  const trStage = (k) => (trainingActive || cur?.status === 'FAILED' ? cur?.stages?.find((s) => s.key === k) : null);
  const exp = mlflow?.experiment ?? null;
  const versions = mlflow?.modelVersions ?? [];
  const medRunning = ['PENDING', 'QUEUED', 'RUNNING'].includes(medJob?.latestRun?.state);
  const waitingBronze = flow?.stages?.find((st) => st.id === 'bronze')?.waitingIn ?? null;

  const jobUrl = (job) => (host && job ? `${host}/jobs/${job.jobId}` : null);
  const taskUrl = (job, t) => (host && job && t?.taskRunId ? `${host}/jobs/${job.jobId}/runs/${t.taskRunId}` : null);
  const tableUrl = (t) => (host ? `${host}/explore/data/${(db.catalog || 'fraud.analytics').replace('.', '/')}/${t}` : null);

  const medallion = (id, label, table, taskKey, purpose, extra = []) => {
    const count = n(mc[table]);
    const t = medTasks[taskKey];
    const ts = taskStatus(t);
    const status = !pipeline ? 'gray' : ts.status === 'blue' || ts.status === 'red' ? ts.status
      : count != null ? 'green' : !dbxConfigured ? 'gray' : 'gray';
    return {
      id, label, layer: 'databricks', shape: 'disc', tint: { Bronze: '#cd7f32', Silver: '#c7d0e0', Gold: '#f5c542' }[label],
      status,
      statusLabel: !pipeline ? CHECKING : ts.status === 'blue' ? `${taskKey.toUpperCase()} TASK RUNNING` : ts.status === 'red' ? `LAST RUN ${ts.label}`
        : count == null ? 'TABLE NOT CREATED' : `${fmtInt(count)} rows`,
      value: count == null ? null : fmtInt(count),
      purpose,
      metrics: [
        ['Table', `${db.catalog || 'fraud.analytics'}.${table}`],
        ['Rows', count == null ? 'not created yet' : fmtInt(count)],
        ...extra,
        ['Last task run', t ? `${ts.label} · ${ago(t.startedAt)} · ${secs(t.startedAt, t.finishedAt)}` : 'never'],
        ['Runs in', medJob ? medJob.name : 'job not deployed']
      ],
      links: [tableUrl(table) && { label: 'Open table in Unity Catalog', url: tableUrl(table) }, taskUrl(medJob, t) && { label: 'Open latest task run', url: taskUrl(medJob, t) }].filter(Boolean)
    };
  };

  const mlStage = (id, label, key, shape, purpose, extraMetrics = []) => {
    const s = trStage(key);
    const ts = taskStatus(s, 'IDLE');
    return {
      id, label, layer: 'ml', shape, status: !training ? 'gray' : ts.status, statusLabel: !training ? CHECKING : s ? ts.label : trainJob ? 'IDLE' : 'JOB NOT DEPLOYED',
      purpose,
      metrics: [
        ['Task', key],
        ['Current run', s ? `${ts.label}${s.startedAt ? ` · ${secs(s.startedAt, s.finishedAt)}` : ''}` : 'no active run'],
        ...(s?.message && s.state !== 'TERMINATED' ? [['Databricks says', s.message]] : []),
        ...extraMetrics
      ],
      links: [taskUrl(trainJob, s) && { label: 'Open task run in Databricks', url: taskUrl(trainJob, s) }, jobUrl(trainJob) && { label: 'Open training job', url: jobUrl(trainJob) }].filter(Boolean)
    };
  };

  const out = (k) => (cur?.stages || []).find((s) => s.key === k)?.output || null;
  const lastOut = (k) => (last?.stages || []).find((s) => s.key === k)?.output || null;

  const nodes = [
    {
      id: 'user-app', label: 'User App', layer: 'client', shape: 'screen', status: 'gray', statusLabel: 'NOT MONITORED',
      purpose: 'React banking app (port 5173). Customers sign in, send money and confirm flagged payments.',
      metrics: [['Active users', fmtInt(system?.counts?.activeUsers)], ['Pending approval', fmtInt(system?.counts?.pendingUsers)], ['Health signal', 'none — static frontend']]
    },
    {
      id: 'api', label: 'Node.js API', layer: 'backend', shape: 'server',
      status: apiOnline == null ? 'gray' : apiOnline ? 'green' : 'red', statusLabel: apiOnline == null ? CHECKING : apiOnline ? 'ONLINE' : 'UNREACHABLE',
      value: stats ? `${fmtInt(stats.totalTx)} tx` : null,
      purpose: 'Express API (port 4000): auth, balance holds, fraud-decision orchestration, admin + Databricks control, Socket.IO.',
      metrics: [['Transactions', fmtInt(stats?.totalTx)], ['Completed', fmtInt(stats?.completed)], ['Challenged', fmtInt(stats?.challenged)], ['Blocked', fmtInt(stats?.blocked)]]
    },
    {
      id: 'fraud-engine', label: 'Fraud Engine', layer: 'ml', shape: 'brain',
      status: !system ? 'gray' : !fe.reachable ? 'red' : 'green',
      statusLabel: !system ? CHECKING : !fe.reachable ? 'OFFLINE → FALLBACK RULES' : fe.modelLoaded ? 'ML MODEL LIVE' : 'BASE MODEL LIVE (RULES)',
      purpose: 'FastAPI scorer (port 8000). Computes real-time features and returns APPROVE / REVIEW / BLOCK. The base model is the rule-based heuristic; trained models are compared against it.',
      metrics: [['Mode', fe.mode || '—'], ['Live model', fe.modelLoaded ? 'trained ML model' : 'base model: heuristic-v1'], ['Thresholds', '<0.30 approve · <0.70 review · else block'], ['URL', fe.url || '—']]
    },
    {
      id: 'alerts', label: 'Decisions & Alerts', layer: 'monitoring', shape: 'bell', status: apiOnline ? 'green' : 'gray',
      statusLabel: `${fmtInt(stats?.fraudAlerts)} fraud alerts`, value: stats ? `${fmtInt(stats.blocked)} blocked` : null,
      purpose: 'Decisions are pushed over Socket.IO to the customer (notification / confirm dialog) and to this console.',
      metrics: [['Fraud alerts', fmtInt(stats?.fraudAlerts)], ['Blocked (24h)', fmtInt(pipeline?.totals24h?.blocked)], ['Review (24h)', fmtInt(pipeline?.totals24h?.challenged)]]
    },
    {
      id: 'mongo', label: 'MongoDB', layer: 'database', shape: 'database',
      status: system?.mongo?.connected ? 'green' : system ? 'red' : 'gray', statusLabel: system?.mongo?.connected ? 'CONNECTED' : system ? 'DISCONNECTED' : CHECKING,
      value: system ? `${fmtInt(system.counts?.totalTx)} tx` : null,
      purpose: 'Operational system of record: users, accounts, ledger, transactions with the features that were scored.',
      metrics: [['Users', fmtInt(system?.counts?.users)], ['Transactions', fmtInt(system?.counts?.totalTx)], ['Blocked', fmtInt(system?.counts?.blockedTx)]]
    },
    {
      id: 'landing', label: 'Landing Export', layer: 'streaming', shape: 'funnel',
      status: !lake ? 'gray' : !dbxConfigured ? 'gray' : lake.lastBatch ? (lake.pending ? 'yellow' : 'green') : 'gray',
      statusLabel: !lake ? CHECKING : !lake.lastBatch ? 'NEVER LANDED' : lake.pending ? `${lake.pending} WAITING` : 'UP TO DATE',
      value: lake ? `${fmtInt(lake.landed)} landed` : null,
      purpose: 'API export (Data Pipeline → Land): settled transactions are written as NDJSON into the Unity Catalog landing volume. This is the ingestion path while Kafka is off.',
      metrics: [['Rows landed', fmtInt(lake?.landed)], ['Waiting', fmtInt(lake?.pending)], ['Last batch', lake?.lastBatch ? `${lake.lastBatch.rows} rows · ${ago(lake.lastBatch.createdAt)}` : 'never'], ['Target', lake?.volume || '—']]
    },
    {
      id: 'kafka', label: 'Kafka', layer: 'streaming', shape: 'ring', status: kafkaOn ? 'green' : 'gray', statusLabel: kafkaOn ? 'ENABLED' : 'OFF (optional path)',
      purpose: 'Optional streaming path: the API publishes txn.events.raw (same event contract as the landing export).',
      metrics: [['Enabled', kafkaOn ? 'yes' : 'no (KAFKA_ENABLED=false)'], ['Brokers', (system?.kafka?.brokers || []).join(', ') || '—']],
      links: kafkaOn ? [{ label: 'Kafka UI (localhost:8080)', url: 'http://localhost:8080' }] : []
    },
    {
      id: 'bridge', label: 'Ingest Bridge', layer: 'streaming', shape: 'funnel', status: 'gray', statusLabel: kafkaOn ? 'NOT MONITORED' : 'OFF (needs Kafka)',
      purpose: 'Python consumer (databricks/jobs/lake_ingest_bridge.py) that uploads Kafka batches to the same landing volume.',
      metrics: [['Health signal', 'none — run it manually']]
    },
    {
      id: 'volume', label: 'Landing Volume', layer: 'databricks', shape: 'cube',
      status: !lake ? 'gray' : lake.landed > 0 ? 'green' : dbxConfigured ? 'yellow' : 'gray',
      statusLabel: !lake ? CHECKING : lake.landed > 0 ? `${lake.recent?.filter((b) => !b.error).length || 0}+ files` : 'EMPTY',
      purpose: 'Unity Catalog volume /Volumes/fraud/landing/events — raw JSON files waiting for Auto Loader.',
      metrics: [['Path', lake?.volume || '—'], ['Rows landed', fmtInt(lake?.landed)]],
      links: [host && { label: 'Open volume', url: `${host}/explore/data/volumes/fraud/landing/events` }].filter(Boolean)
    },
    medallion('bronze', 'Bronze', 'bronze_events', 'bronze', 'Auto Loader (availableNow) appends every landed JSON event, schema-on-read.'),
    medallion('silver', 'Silver', 'silver_events', 'silver', 'Typed, validated against the data contract, de-duplicated. Bad rows go to quarantine.', [['Quarantined', fmtInt(mc.silver_quarantine)]]),
    medallion('gold', 'Gold', 'gold_fraud_predictions', 'gold', 'Business + ML tables: decisions, hourly KPIs, per-user behaviour.', [['KPI hours', fmtInt(mc.gold_fraud_kpis)], ['User profiles', fmtInt(mc.gold_user_behavior)]]),
    {
      ...mlStage('dataset', 'Training Dataset', 'load_dataset', 'crystal', 'Stage 1: the chosen dataset (synthetic, platform silver_events or public benchmark) is written to ml_dataset as a versioned Delta table.',
        [['Chosen dataset', cur?.dataset?.replaceAll('_', ' ') || '—'], ['Rows', fmtInt((out('load_dataset') || lastOut('load_dataset'))?.rows)], ['Fraud rate', (out('load_dataset') || lastOut('load_dataset'))?.fraud_rate ?? '—']]),
      value: cur?.dataset ? cur.dataset.replaceAll('_', ' ') : null
    },
    mlStage('features', 'Features + Quality', 'build_features', 'gear', 'Stage 2: the same 8 features the live engine computes, quality checks, seeded 75/25 split → ml_features.',
      [['Features', (out('build_features') || lastOut('build_features'))?.n_features ?? '—'], ['Train / test', (() => { const o = out('build_features') || lastOut('build_features'); return o ? `${fmtInt(o.n_train)} / ${fmtInt(o.n_test)}` : '—'; })()]]),
    {
      ...mlStage('train', 'Train Model', 'train_model', 'cube', 'Stage 3: fits the chosen scikit-learn model and logs it to MLflow.',
        [['Model', cur?.modelType?.replaceAll('_', ' ') || '—'], ['Fit time', (out('train_model') || lastOut('train_model'))?.train_seconds != null ? `${(out('train_model') || lastOut('train_model')).train_seconds}s` : '—']]),
      value: cur?.modelType ? cur.modelType.replaceAll('_', ' ') : null
    },
    {
      ...mlStage('evaluate', 'Evaluate vs Base', 'evaluate_register', 'orb', 'Stage 4: scores the held-out test set with the new model AND the live base model, then registers the version.',
        [['Last F1', fmtMetric(last?.metrics?.f1)], ['Last PR-AUC', fmtMetric(last?.metrics?.prAuc)], ['Base PR-AUC', fmtMetric(last?.baselineMetrics?.prAuc)]]),
      value: last?.metrics?.f1 != null ? `F1 ${fmtMetric(last.metrics.f1)}` : null,
      meter: last?.metrics?.rocAuc ?? null
    },
    {
      id: 'mlflow', label: 'MLflow', layer: 'ml', shape: 'orb',
      bars: (mlflow?.runs || []).map((r) => r.metrics?.roc_auc).filter((v) => v != null).slice(0, 5).reverse(),
      status: !mlflow ? 'gray' : !mlflow.configured ? 'gray' : !exp ? 'gray' : mlflow.runs?.[0]?.status === 'RUNNING' ? 'blue' : 'green',
      statusLabel: !mlflow ? CHECKING : !exp ? 'NO EXPERIMENT YET' : `${mlflow.runs.length} runs tracked`,
      purpose: 'Databricks-hosted MLflow: parameters, metrics, base-model metrics and the model artifact of every run.',
      metrics: [['Experiment', exp?.name || '—'], ['Latest run', mlflow?.runs?.[0] ? `${mlflow.runs[0].runName || ''} · ${ago(mlflow.runs[0].startTime)}` : '—']],
      links: [host && exp && { label: 'Open experiment', url: `${host}/ml/experiments/${exp.id}` }].filter(Boolean)
    },
    {
      id: 'registry', label: 'Model Registry', layer: 'ml', shape: 'crystal', status: versions.length ? 'green' : 'gray', count: versions.length,
      statusLabel: !mlflow ? CHECKING : versions.length ? `v${versions[0].version} latest` : 'NO VERSIONS YET',
      value: versions.length ? `${versions.length} versions` : null,
      purpose: 'Unity Catalog registered model. Deploying a version to the fraud engine is a manual step (not automated yet).',
      metrics: [['Model', mlflow?.registeredModel || '—'], ['Versions', versions.length], ['Deployment', 'manual — base model stays live']],
      links: [host && mlflow?.registeredModel && { label: 'Open model in Unity Catalog', url: `${host}/explore/data/models/${mlflow.registeredModel.replaceAll('.', '/')}` }].filter(Boolean)
    }
  ].filter((node) => kafkaOn || !['kafka', 'bridge'].includes(node.id)).map((node) => ({ ...node, ...LAYOUT[node.id] }));

  const databricks = {
    id: 'databricks', label: 'Databricks workspace', layer: 'databricks', shape: 'platform',
    status: !dbxConfigured ? 'gray' : !pipeline ? 'gray' : db.jobs == null ? 'red' : jobs.length < 2 ? 'yellow' : medRunning || trainingActive ? 'blue' : 'green',
    statusLabel: !dbxConfigured ? 'NOT CONFIGURED' : !pipeline ? CHECKING : db.jobs == null ? 'UNREACHABLE' : jobs.length < 2 ? 'JOBS NOT DEPLOYED' : medRunning || trainingActive ? 'COMPUTE RUNNING' : 'CONNECTED · IDLE',
    purpose: 'Serverless workspace hosting the landing volume, the medallion tables, the training job, MLflow and the model registry.',
    metrics: [['Workspace', host ? host.replace(/^https?:\/\//, '') : '—'], ['Catalog', db.catalog || '—'],
      ['Medallion job', medJob ? `${medJob.latestRun?.state || 'never run'}${medJob.latestRun?.resultState ? ` · ${medJob.latestRun.resultState}` : ''}` : 'not deployed'],
      ['Training job', trainJob ? `${trainJob.latestRun?.state || 'never run'}${trainJob.latestRun?.resultState ? ` · ${trainJob.latestRun.resultState}` : ''}` : 'not deployed']],
    links: [host && { label: 'Open workspace', url: host }, jobUrl(medJob) && { label: 'Medallion job', url: jobUrl(medJob) }, jobUrl(trainJob) && { label: 'Training job', url: jobUrl(trainJob) }].filter(Boolean)
  };

  const feUp = Boolean(fe.reachable);
  const t = (k) => ['blue', 'green'].includes(taskStatus(trStage(k)).status) && trainingActive;
  const edges = [
    { from: 'user-app', to: 'api', label: 'REST transfer', active: apiOnline, flow: 'hot' },
    { from: 'api', to: 'fraud-engine', label: 'POST /score', active: feUp, flow: 'hot' },
    { from: 'fraud-engine', to: 'alerts', label: 'decision', active: feUp, flow: 'hot' },
    { from: 'api', to: 'mongo', label: 'write transaction + features', active: Boolean(system?.mongo?.connected), flow: 'hot' },
    { from: 'mongo', to: 'landing', label: 'settled transactions', active: Boolean(lake?.lastBatch), flow: 'cold', queue: lake ? { n: lake.pending, label: 'waiting to land' } : null },
    { from: 'landing', to: 'volume', label: 'Files API · NDJSON', active: Boolean(lake?.lastBatch), flow: 'cold' },
    ...(kafkaOn ? [
      { from: 'api', to: 'kafka', label: 'txn.events.raw', active: true, flow: 'cold', optional: true },
      { from: 'kafka', to: 'bridge', label: 'consume', active: true, flow: 'cold', optional: true },
      { from: 'bridge', to: 'volume', label: 'Files API', active: dbxConfigured, flow: 'cold', optional: true }
    ] : []),
    { from: 'volume', to: 'bronze', label: 'Auto Loader', active: n(mc.bronze_events) != null, running: medTasks.bronze?.state === 'RUNNING', flow: 'cold', queue: waitingBronze != null ? { n: waitingBronze, label: 'waiting for Bronze' } : null },
    { from: 'bronze', to: 'silver', label: 'clean + validate', active: n(mc.silver_events) != null, running: medTasks.silver?.state === 'RUNNING', flow: 'cold' },
    { from: 'silver', to: 'gold', label: 'aggregate', active: n(mc.gold_fraud_predictions) != null, running: medTasks.gold?.state === 'RUNNING', flow: 'cold' },
    { from: 'silver', to: 'dataset', label: 'platform_transactions dataset', active: trainingActive && cur?.dataset === 'platform_transactions', flow: 'train' },
    { from: 'dataset', to: 'features', label: 'ml_dataset', active: t('build_features') || t('load_dataset'), flow: 'train' },
    { from: 'features', to: 'train', label: 'ml_features (train split)', active: t('train_model') || t('build_features'), flow: 'train' },
    { from: 'train', to: 'evaluate', label: 'model', active: t('evaluate_register') || t('train_model'), flow: 'train' },
    { from: 'train', to: 'mlflow', label: 'log params + model', active: t('train_model'), flow: 'train' },
    { from: 'fraud-engine', to: 'evaluate', label: 'base model rules (comparison)', active: t('evaluate_register'), flow: 'train', manual: true },
    { from: 'evaluate', to: 'registry', label: 'register version', active: t('evaluate_register'), flow: 'train' },
    { from: 'registry', to: 'fraud-engine', label: 'deploy (manual, not automated)', active: false, flow: 'train', manual: true }
  ];

  return { nodes, edges, trainingActive, platform: databricks, medRunning };
}

/** Ordered stops for the guided walk-through / stage list. */
export function laneStops(nodes) {
  return LANES.map((lane) => ({
    ...lane,
    nodes: nodes.filter((nd) => nd.lane === lane.id).sort((a, b) => lane.dir * (a.pos[0] - b.pos[0]))
  }));
}

/* ---------------- training pipeline (Model Training page) ---------------- */

const DATASET_SOURCE = {
  synthetic_payments: ['Seeded generator', 'numpy · 50k payments'],
  platform_transactions: ['silver_events', 'your lakehouse data'],
  creditcard_benchmark: ['ref_creditcard', 'OpenML 1597, cached Delta']
};

export function buildTrainingGraph({ run, options, mlflow, system, host }) {
  const st = (k) => run?.stages?.find((s) => s.key === k) || null;
  const o = (k) => st(k)?.output || null;
  const active = run && ['QUEUED', 'RUNNING'].includes(run.status);
  const ds = run?.dataset || 'synthetic_payments';
  const modelLabel = options?.models?.find((m) => m.id === run?.modelType)?.label || run?.modelType || 'model';
  const stage = (k) => (run ? taskStatus(st(k), run.status === 'FAILED' ? 'SKIPPED' : 'WAITING') : { status: 'gray', label: 'NO RUN YET' });
  const [srcLabel, srcSub] = DATASET_SOURCE[ds] || [ds, ''];
  const load = stage('load_dataset'); const feat = stage('build_features'); const tr = stage('train_model'); const ev = stage('evaluate_register');
  const pos = { source: [-9, 0, 0], dataset: [-5.4, 0, 0], features: [-1.8, 0, 0], train: [1.8, 0, 0], evaluate: [5.4, 0, 0], registry: [9, 0, 0], mlflow: [3.6, 0, 4.4], base: [5.4, 0, -4.4] };
  const lift = { dataset: 1, train: 1, registry: 1 };

  const nodes = [
    { id: 'source', label: srcLabel, layer: 'databricks', shape: ds === 'platform_transactions' ? 'disc' : 'database', tint: ds === 'platform_transactions' ? '#c7d0e0' : undefined,
      status: load.status === 'gray' ? 'gray' : load.status === 'yellow' ? 'yellow' : 'green', statusLabel: srcSub, metrics: [['Dataset', ds.replaceAll('_', ' ')], ['Source', o('load_dataset')?.source || srcSub]] },
    { id: 'dataset', label: 'ml_dataset', layer: 'ml', shape: 'crystal', status: load.status, statusLabel: load.label, value: o('load_dataset') ? `${Number(o('load_dataset').rows).toLocaleString()} rows` : null,
      metrics: [['Rows', o('load_dataset')?.rows?.toLocaleString?.() ?? '—'], ['Fraud rows', o('load_dataset')?.fraud_rows ?? '—'], ['Delta version', o('load_dataset')?.delta_version ?? '—'], ['Stage time', secs(st('load_dataset')?.startedAt, st('load_dataset')?.finishedAt)]] },
    { id: 'features', label: 'Features + QA', layer: 'ml', shape: 'gear', status: feat.status, statusLabel: feat.label, value: o('build_features') ? `${o('build_features').n_features} features` : null,
      metrics: [['Features', o('build_features')?.feature_names?.join(', ') ?? '—'], ['Train / test', o('build_features') ? `${o('build_features').n_train} / ${o('build_features').n_test}` : '—'], ['Dropped rows', o('build_features')?.dropped_rows ?? '—']] },
    { id: 'train', label: modelLabel, layer: 'ml', shape: 'cube', status: tr.status, statusLabel: tr.label, value: o('train_model') ? `${o('train_model').train_seconds}s fit` : null,
      metrics: [['Model', modelLabel], ['Params', o('train_model')?.params ? Object.entries(o('train_model').params).map(([k, v]) => `${k}=${v}`).join(', ') : '—'], ['Train F1', fmtMetric(o('train_model')?.train_f1)]] },
    { id: 'evaluate', label: 'Evaluate', layer: 'ml', shape: 'orb', status: ev.status, statusLabel: ev.label, value: run?.metrics?.f1 != null ? `F1 ${fmtMetric(run.metrics.f1)}` : null, meter: run?.metrics?.rocAuc ?? null,
      metrics: [['Test F1', fmtMetric(run?.metrics?.f1)], ['PR-AUC', fmtMetric(run?.metrics?.prAuc)], ['ROC-AUC', fmtMetric(run?.metrics?.rocAuc)], ['Base PR-AUC', fmtMetric(run?.baselineMetrics?.prAuc)]] },
    { id: 'base', label: 'Base model (live)', layer: 'ml', shape: 'brain', status: system?.fraudEngine?.reachable ? 'green' : 'gray', statusLabel: 'rule-based heuristic',
      metrics: [['Role', 'scores live payments today; used as the comparison baseline'], ['Engine', system?.fraudEngine?.mode || '—']] },
    { id: 'mlflow', label: 'MLflow', layer: 'ml', shape: 'orb', bars: (mlflow?.runs || []).map((r) => r.metrics?.roc_auc).filter((v) => v != null).slice(0, 5).reverse(), status: run?.mlflowRunId ? 'green' : tr.status === 'blue' ? 'blue' : 'gray', statusLabel: run?.mlflowRunId ? `run ${run.mlflowRunId.slice(0, 8)}` : 'waiting',
      metrics: [['Experiment', mlflow?.experiment?.name || '—'], ['Run', run?.mlflowRunId || '—']] },
    { id: 'registry', label: 'Registry', layer: 'ml', shape: 'crystal', count: run?.registeredVersion ? 1 : 0, status: run?.registeredVersion ? 'green' : ev.status === 'blue' ? 'blue' : ev.status === 'red' ? 'red' : 'gray',
      statusLabel: run?.registeredVersion ? `v${run.registeredVersion}` : 'not registered', metrics: [['Model', run?.registeredModel || mlflow?.registeredModel || '—'], ['Version', run?.registeredVersion || '—']] }
  ].map((nd) => ({ ...nd, pos: pos[nd.id], lift: lift[nd.id] || 0, purpose: '', links: [] }));

  const on = (s) => active && ['blue', 'green'].includes(s.status);
  const edges = [
    { from: 'source', to: 'dataset', label: 'load', active: on(load), flow: 'train' },
    { from: 'dataset', to: 'features', label: 'engineer', active: on(feat), flow: 'train' },
    { from: 'features', to: 'train', label: 'train split', active: on(tr), flow: 'train' },
    { from: 'train', to: 'evaluate', label: 'test split', active: on(ev), flow: 'train' },
    { from: 'train', to: 'mlflow', label: 'log', active: on(tr), flow: 'train' },
    { from: 'base', to: 'evaluate', label: 'baseline', active: on(ev), flow: 'train', manual: true },
    { from: 'evaluate', to: 'registry', label: 'register', active: on(ev), flow: 'train' }
  ];
  void host;
  return { nodes, edges, active };
}
