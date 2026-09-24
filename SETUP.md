# SentinelPay — Setup & Run Guide

## 0. Prerequisites (all free)

| Tool | Version | Check | Install |
|------|---------|-------|---------|
| Node.js | 20 LTS+ | `node -v` | https://nodejs.org |
| Docker Desktop | 4.x | `docker -v` | https://www.docker.com/products/docker-desktop |
| Git | 2.4+ | `git --version` | https://git-scm.com |
| Python | 3.11+ | `python --version` | https://python.org |
| Databricks CLI | latest | `databricks -v` | `pip install databricks-cli` or `curl -V` bundle |
| MongoDB Atlas | M0 free | — | https://www.mongodb.com/cloud/atlas |

> Your machine currently has **no Node.js, npm, git, or Docker** on PATH (verified).
> Install Node LTS, Docker Desktop and Git first — the `node` found on PATH today is VS Code's internal Electron, not a real Node runtime.

## 1. Clone & install

```powershell
git clone https://github.com/dream12312/Fraud-detection-system.git
cd Fraud-detection-system
npm install                     # installs API + both React apps (workspaces)
python -m venv .venv
.\.venv\Scripts\activate
pip install -r services\fraud-engine\requirements.txt
pip install -r services\simulator\requirements.txt
```

## 2. Configure environment

```powershell
Copy-Item .env.example .env
# Set MONGODB_URI to your Atlas connection string, or keep local Docker Mongo
```

## 3. Start infrastructure

```powershell
docker compose up -d            # MongoDB (local) + Kafka + Kafka UI
npm run dev                     # API :4000, User app :5173, Admin app :5174
```

Seeded admin: `admin@sentinelpay.local` / `Admin123!`

## 4. Train the ML model (optional but recommended)

```powershell
.\.venv\Scripts\activate
python services\ml\train_model.py
# Downloads OpenML creditcard dataset, trains LR/RF/XGBoost, picks champion by PR-AUC,
# writes services\fraud-engine\artifacts\model.joblib
```

Without a trained model the Fraud Engine scores with deterministic heuristics,
so the full flow still works.

## 5. Start the Fraud Engine

```powershell
uvicorn app:app --port 8000 --app-dir services\fraud-engine
```

## 6. Generate traffic (simulator)

```powershell
python services\simulator\sim.py --normal 20 --fraud 10 --register
```

- Open **User app** http://localhost:5173 → register/login → see fraud warnings, confirm/report
- Open **Admin app** http://localhost:5174 → login as admin → live transactions, risk scores, user management, pipeline tab
- Kafka UI: http://localhost:8080

## 7. Databricks pipeline (Free Edition)

```powershell
pip install confluent-kafka databricks-sdk
$env:DATABRICKS_HOST="https://dbc-....cloud.databricks.com"
$env:DATABRICKS_TOKEN="<PAT>"
python databricks\jobs\lake_ingest_bridge.py    # Kafka -> UC Volume landing

databricks bundle deploy -t dev                 # deploys medallion job (bronze->silver->gold)
```

In the Databricks workspace also run `databricks\notebooks\setup_catalog.sql` once
(catalog/schema/volume creation — see below).

## 8. GitHub

```powershell
git init
git remote add origin https://github.com/dream12312/Fraud-detection-system.git
git add -A
git commit -m "feat: SentinelPay MVP - MERN + Kafka + Databricks + ML"
git push -u origin main
```

## Verification checklist

- [ ] `curl http://localhost:4000/health` → `{"status":"ok"}`
- [ ] Register a user in the User app → transfer $10 → status COMPLETED
- [ ] Transfer $12,000 → status BLOCKED with red fraud warning + notification
- [ ] Transfer $6,000 → status CHALLENGED → Confirm / Report fraud buttons work
- [ ] Admin console shows all three transactions with risk scores
- [ ] `python services\simulator\sim.py --loop` streams traffic, admin feed updates live
- [ ] Fraud Engine health: `http://localhost:8000/health` → `model_loaded` true/false
- [ ] Kafka UI shows topics receiving events (requires `KAFKA_ENABLED=true` in `.env`)
