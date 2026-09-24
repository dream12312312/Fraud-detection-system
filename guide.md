# SentinelPay — Project Guide

SentinelPay is a demo financial-fraud-detection platform. A **User app** for banking,
an **Admin (Developer) console** for operations, a **Node.js API**, a **FastAPI fraud
engine**, and a **Databricks lakehouse** (Spark + Delta + MLflow) for data engineering
and ML training.

```
User App (React :5173)      Admin App (React :5174)
        \                    /
         v                  v
        SentinelPay API (Node/Express :4000)  <----->  MongoDB
              |
              +--> Fraud Scoring Engine (FastAPI :8000, ML or heuristic)
              +--> Kafka events (optional)
                     |
                     v
              Lake ingest bridge --> Databricks Volume
                     |
                     v
              Bronze --> Silver --> Gold (Delta, Spark jobs)
                     |
                     v
              MLflow (Databricks-hosted) --> trained fraud model
```

---

# USER GUIDE

## 1. Start the project

Open a terminal in the project root and run:

```
npm run dev
```

This starts:
- the API on http://localhost:4000
- the User app on http://localhost:5173
- the Admin console on http://localhost:5174

MongoDB must be running locally (`mongodb://localhost:27017`).

## 2. Register

Open http://localhost:5173 → **Create an account**.
Enter name, email and password (8+ characters).

## 3. Account approval

New accounts start as **PENDING** and cannot sign in until an admin approves them.
(For testing, the admin approve step takes a few seconds — see Developer Guide.)

## 4. Log in

After approval, sign in with your email and password.

## 5. View balance

The **Overview** page shows your available balance, amounts on hold, recent
transactions, 7-day spending chart and your latest alerts.

## 6. Make a payment / transfer money

1. Go to **Beneficiaries** and add a payee (nickname + account number).
2. Go to **Transfer**, pick the payee, enter an amount and country, then **Send payment**.
3. Every payment is scored in real time by the fraud engine.

## 7. Transaction statuses

| Status | Meaning |
|---|---|
| COMPLETED | Approved and sent |
| CHALLENGED | Your payment is being reviewed for security reasons — confirm it to continue |
| BLOCKED | This transaction was blocked because suspicious activity was detected |
| FAILED | Could not be completed (e.g. insufficient balance) |

## 8. Fraud alerts

Alerts appear as pop-ups, in **Alerts**, and on the Overview page.
When a payment is challenged you get a confirmation dialog: **Confirm payment**
(completes it) or **Report fraud** (blocks it and notifies the bank).

## 9. Temporary passwords

If an administrator gives you a temporary password, signing in forces you to set
your own password before anything else. The temporary password only works once.

---

# DEVELOPER GUIDE

## Project architecture

| Path | What it is |
|---|---|
| `apps/user-app` | React banking app (Vite, :5173) |
| `apps/admin-app` | React admin console (Vite, :5174) |
| `services/api` | Express API (:4000): auth, banking, admin, socket.io, Kafka producer |
| `services/fraud-engine` | FastAPI scorer (:8000): trained ML model or heuristic fallback |
| `services/ml` | Local training script + artifacts (`model.joblib`) |
| `databricks/` | Databricks Asset Bundle: notebooks + lake ingest bridge |
| `resources/` | Databricks job definitions (medallion pipeline, model training) |

## Fraud decision flow (normal operation)

```
User transaction (POST /transfer)
  -> hold placed on account
  -> fraud engine /score (features: amount vs 30d avg, night, foreign country,
     new beneficiary, 1h velocity)
  -> decision APPROVE | REVIEW | BLOCK
  -> stored in MongoDB (decisionSource: ML_MODEL | HEURISTIC | RULES_FALLBACK)
  -> user + admin notified (socket.io)
  -> Kafka event (when enabled) -> bridge -> Databricks Bronze/Silver/Gold
```

The fraud engine has two modes:
- **ML_MODEL** — a trained model is loaded from `services/ml/artifacts/`.
- **HEURISTIC** — no model yet; deterministic rules score the transaction.
Both are legitimate sources; the schema allows both.

## Data pipeline (Bronze/Silver/Gold)

1. Enable Kafka (`KAFKA_ENABLED=true`) and start Kafka locally.
2. Set `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_VOLUME_PATH` in `.env`.
3. Run the bridge: `python databricks/jobs/lake_ingest_bridge.py`
   (needs `confluent_kafka` + `databricks-sdk`).
4. Deploy + run the medallion job: `databricks bundle deploy`, then run
   `sentinelpay-medallion-pipeline` in the Databricks Jobs UI.
5. Tables appear in catalog `fraud.analytics`: `bronze_events`, `silver_events`,
   `gold_fraud_predictions`, `gold_fraud_kpis`, `gold_user_behavior`.

## Model training (manual only)

Training never starts automatically. In the Admin console → **Model Training** →
**Start Model Training** (you will confirm that Databricks compute is used).

1. Deploy the training job: `databricks bundle deploy`
   (creates job `sentinelpay-model-training` from `resources/model_training.yml`).
2. Clicking start triggers the job via the Databricks Jobs API.
3. The notebook (`databricks/notebooks/04_train_model.py`) trains logistic
   regression + random forest, and logs params/metrics to workspace **MLflow**
   (experiment `sentinelpay-fraud`) — inspect it in the Databricks MLflow UI.
4. The console polls the run state (RUNNING → COMPLETED/FAILED) and pulls the
   real MLflow metrics when the run finishes.

To use a trained model in real-time scoring, export the champion to
`services/ml/artifacts/` (see `services/ml/train_model.py`) and restart the
fraud engine.

## Monitoring

Admin console sections:
- **Transactions / Users** — live operations
- **Data Processing** — 24h volume, decisions per hour, errors, medallion record
  counts (needs `DATABRICKS_WAREHOUSE_ID` for live Delta counts)
- **System** — Mongo, fraud engine, Kafka, Databricks configuration state

Everything shown comes from real system data; unavailable integrations show an
honest "not configured" state instead of fake numbers.

## User management

- Search/filter users, open **Details** (accounts + transaction history)
- Approve / Disable / Block
- **Set temp password** — generates a random password shown ONCE, stores only a
  bcrypt hash, and forces the user to change it at next sign-in.

## Environment variables (.env)

| Key | Purpose |
|---|---|
| MONGODB_URI | Mongo connection string |
| PORT | API port (4000) |
| JWT_SECRET / JWT_EXPIRES_IN / REFRESH_TOKEN_DAYS | auth tokens |
| CORS_ORIGINS | allowed frontends |
| KAFKA_ENABLED / KAFKA_BROKERS | event backbone |
| FRAUD_ENGINE_URL | fraud scorer address |
| DATABRICKS_HOST / DATABRICKS_TOKEN | Databricks REST access |
| DATABRICKS_WAREHOUSE_ID | SQL warehouse for live table counts |
| DATABRICKS_CATALOG / DATABRICKS_SCHEMA / DATABRICKS_VOLUME_PATH | lakehouse locations |

**Never commit `.env`** — it holds tokens and secrets.

## Testing the system as USER + DEVELOPER at once

1. Run `npm run dev`.
2. In a private window open :5173 → register a user (it stays PENDING).
3. In another window open :5174 → sign in as admin
   (`admin@sentinelpay.local` / from `.env` ADMIN_PASSWORD).
4. Approve the user in **Users**.
5. Sign in as the user, add a beneficiary, send $50 — expect **COMPLETED**.
6. Send a large foreign transfer (e.g. $4,000 to NG) — expect
   **"being reviewed for security reasons"** → confirm or report.
7. Watch both windows: socket.io shows the transaction and alerts live on both sides.

## Troubleshooting

| Problem | Fix |
|---|---|
| API crashes with `decisionSource` enum error | Fixed — engine sources `ML_MODEL`/`HEURISTIC` are valid; if you add a new engine source, add it to the Transaction enum in `services/api/src/models.js` |
| Payments return "could not process" | Check the API logs — technical detail is logged server-side, never shown to users |
| Fraud engine unreachable | Payments fall back to local rules (`RULES_FALLBACK`); start it with `uvicorn app:app --port 8000` from `services/fraud-engine` |
| Training start says "Databricks is not configured" | Set `DATABRICKS_HOST` + `DATABRICKS_TOKEN` in `.env`, then `databricks bundle deploy` |
| Medallion counts show "n/a" | Set `DATABRICKS_WAREHOUSE_ID` in `.env` |
| Port 4000 in use | The API retries automatically; if stuck, kill the old node process |
| Node `--watch` crashes on Windows | The dev script uses nodemon instead, which is stable |
