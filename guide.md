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

1. Go to **Payees** and add a payee (nickname + account number).
2. Go to **Send money**, pick the payee, enter an amount and country, then **Send payment**.
3. Every payment is scored in real time by the fraud engine. The panel
   **What happened to your payment** shows each step: risk signals measured,
   the fraud-engine score, the decision, and when it was added to the data lake.
4. In **Transactions**, click any payment to see the same step-by-step path.

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
| `databricks/` | Notebooks (medallion 01–03, training 10–13) + lake ingest bridge |
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
  -> landing export (or Kafka + bridge) -> Databricks volume -> Bronze/Silver/Gold
```

The fraud engine has two modes:
- **ML_MODEL** — a trained model is loaded from `services/ml/artifacts/`.
- **HEURISTIC** — no model yet; deterministic rules score the transaction.
Both are legitimate sources; the schema allows both.

## Data pipeline (Bronze/Silver/Gold)

Everything is controlled from the admin console; the Databricks token stays in
the API server and never reaches a browser.

1. **Databricks → Set up workspace** (once, and after editing a notebook). It
   creates catalog `fraud`, schemas `analytics` + `landing`, the volume
   `/Volumes/fraud/landing/events`, uploads the 7 notebooks to
   `/Users/<you>/sentinelpay/notebooks` and creates/updates two serverless jobs.
   On Free Edition the catalog can only be created through SQL, so
   `DATABRICKS_WAREHOUSE_ID` must be set. No compute is used by set-up.
2. **Data pipeline → Land N new**: settled transactions are exported from
   MongoDB as NDJSON into the landing volume (`data/transactions/dt=…/`). Each
   transaction is landed once (`lakeLandedAt`). With Kafka enabled, the lake
   ingest bridge writes the same event shape into the same folder.
3. **Data pipeline → Run pipeline** starts job `sentinelpay-medallion-pipeline`:
   `01_bronze` (Auto Loader, availableNow) → `02_silver` (types, data contract,
   dedupe, `silver_quarantine`) → `03_gold` (`gold_fraud_predictions`,
   `gold_fraud_kpis`, `gold_user_behavior`). Task states and row counts appear
   live on the page.

The bundle files (`databricks.yml`, `resources/*.yml`) describe the same jobs
for anyone using the Databricks CLI (`databricks bundle deploy`).

## Model training (manual only)

Training never starts automatically. Admin console → **Model training**:

1. Choose a model: Logistic Regression, Decision Tree, Random Forest,
   Gradient Boosting or Naive Bayes (scikit-learn, preset parameters).
2. Choose a dataset:
   - **Synthetic payments**: seeded generator, 50k rows, same raw fields as live
     payments, no download.
   - **Platform transactions**: your own `silver_events` (needs >= 50 labelled
     rows; labels = blocked or user-reported fraud, i.e. the base model's decisions).
   - **Credit-card benchmark**: OpenML 1597, downloaded once and cached as the
     Delta table `ref_creditcard`; benchmark only, since its PCA features do not
     exist in live payments.
3. **Start training** (confirm) runs job `sentinelpay-model-training`, four tasks:
   `10_load_dataset` → `11_build_features` (the fraud engine's 8 features, quality
   checks, seeded 75/25 split) → `12_train_model` (logs to MLflow) →
   `13_evaluate_register` (scores the test set with the new model and with the
   live base model, then registers a version of `fraud.analytics.fraud_classifier`).
4. The page and the 3D view show each stage's real Databricks task state and
   output (rows, features, metrics). Results, history and a base-model comparison
   are kept per run.

Registering a version does not deploy it: live payments keep using the base model
(the fraud engine's rule-based heuristic) until a model is exported to
`services/ml/artifacts/` and the engine is restarted.

## Monitoring

Admin console navigation:
- **Overview**: the flow MongoDB → landing → Bronze → Silver → Gold → model with
  real counts, KPIs, live transactions and a "needs attention" list.
- **Transactions / Users & money**: operations (see below).
- **3D Architecture**: the whole system as three lanes (real-time serving,
  ingestion & lakehouse, machine-learning loop) on a Databricks platform. Every
  node shows live status; click one for details and links into Databricks. Use
  **Walk through the pipeline** for a guided, step-by-step tour, or the 2D view
  when WebGL is unavailable.
- **Data pipeline / Model training / Databricks**: control pages described above.
- **System health**: API, MongoDB, fraud engine, Kafka, Databricks, SQL warehouse.

Everything shown comes from real system data; unavailable integrations show an
honest "not set up" state instead of fake numbers.

## User management

Admin console → **Users & money** → click a user:
- **Money**: credit or debit any account (a reason is required; it is written to
  the ledger as a DEPOSIT/WITHDRAWAL and the user is notified), set daily limits,
  open a savings account. Debits cannot exceed balance minus holds.
- **Transactions**: open any payment to see its processing path; challenged or
  stuck payments can be **approved** (money moves, hold released) or **blocked**
  (hold released).
- **Profile**: name, email, home country, phone, role.
- **Payees**, **Notifications**, and **Access**: status (active / pending /
  disabled / blocked), one-time temporary password, delete user with all data.
- **Create user** makes an approved account with an opening balance and a
  one-time temporary password.

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
