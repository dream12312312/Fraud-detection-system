# Databricks notebook source
# MAGIC %md
# MAGIC ## Training stage 3 - train the chosen model
# MAGIC Fits one classic scikit-learn model on the train split of `ml_features` and
# MAGIC logs parameters, training metrics and the model to Databricks MLflow.

# COMMAND ----------

# MAGIC %pip install -q scikit-learn==1.6.0 "mlflow>=2.19"

# COMMAND ----------

dbutils.library.restartPython()

# COMMAND ----------

import json
import time
import mlflow
import mlflow.sklearn
from mlflow.models import infer_signature
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier
from sklearn.naive_bayes import GaussianNB
from sklearn.metrics import f1_score, roc_auc_score

dbutils.widgets.text("catalog", "fraud")
dbutils.widgets.text("schema", "analytics")
dbutils.widgets.text("model", "logistic_regression")
dbutils.widgets.text("dataset", "synthetic_payments")
dbutils.widgets.text("seed", "42")
dbutils.widgets.text("sentinelpay_run_id", "")
catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")
model_name = dbutils.widgets.get("model")
dataset = dbutils.widgets.get("dataset")
seed = int(dbutils.widgets.get("seed") or 42)
sp_run = dbutils.widgets.get("sentinelpay_run_id")

MODELS = {
    "logistic_regression": (lambda: Pipeline([("scaler", StandardScaler()),
                             ("clf", LogisticRegression(max_iter=1000, class_weight="balanced", random_state=seed))]),
                            {"C": 1.0, "class_weight": "balanced", "scaling": "standard"}),
    "decision_tree": (lambda: DecisionTreeClassifier(max_depth=6, min_samples_leaf=20, class_weight="balanced", random_state=seed),
                      {"max_depth": 6, "min_samples_leaf": 20, "class_weight": "balanced"}),
    "random_forest": (lambda: RandomForestClassifier(n_estimators=150, max_depth=10, min_samples_leaf=5,
                                                     class_weight="balanced", random_state=seed, n_jobs=-1),
                      {"n_estimators": 150, "max_depth": 10, "min_samples_leaf": 5, "class_weight": "balanced"}),
    "gradient_boosting": (lambda: HistGradientBoostingClassifier(max_iter=200, learning_rate=0.1, class_weight="balanced", random_state=seed),
                          {"max_iter": 200, "learning_rate": 0.1, "class_weight": "balanced"}),
    "naive_bayes": (lambda: Pipeline([("scaler", StandardScaler()), ("clf", GaussianNB())]),
                    {"var_smoothing": 1e-9, "scaling": "standard"}),
}
if model_name not in MODELS:
    raise Exception(f"unknown model '{model_name}'")

pdf = spark.table(f"{catalog}.{schema}.ml_features").toPandas()
train = pdf[pdf["split"] == "train"]
feature_names = [c for c in pdf.columns if c not in ("label", "split")]
X, y = train[feature_names].astype(float), train["label"].astype(int)
dataset_version = spark.sql(f"DESCRIBE HISTORY {catalog}.{schema}.ml_dataset LIMIT 1").collect()[0]["version"]

me = spark.sql("SELECT current_user() AS u").collect()[0]["u"]
mlflow.set_experiment(f"/Users/{me}/sentinelpay-fraud")

build, params = MODELS[model_name]
with mlflow.start_run(run_name=f"{model_name} · {dataset}") as run:
    mlflow.set_tags({"sentinelpay_run_id": sp_run, "model": model_name, "dataset": dataset})
    t0 = time.time()
    model = build().fit(X, y)
    train_seconds = round(time.time() - t0, 2)
    proba = model.predict_proba(X)[:, 1]
    train_metrics = {"train_f1": round(f1_score(y, proba >= 0.5), 4), "train_roc_auc": round(roc_auc_score(y, proba), 4),
                     "train_seconds": train_seconds}
    mlflow.log_params({"model": model_name, "dataset": dataset, "seed": seed, "n_train": len(X),
                       "n_features": len(feature_names), "features": ",".join(feature_names),
                       "dataset_table_version": int(dataset_version), **params})
    mlflow.log_metrics(train_metrics)
    # cloudpickle: MLflow 3's default (skops) rejects tree-based models' internal
    # types, which broke decision_tree / random_forest / gradient_boosting runs.
    mlflow.sklearn.log_model(model, "model", signature=infer_signature(X.head(50), proba[:50]),
                             input_example=X.head(3), serialization_format="cloudpickle")

summary = {"mlflow_run_id": run.info.run_id, "experiment_id": run.info.experiment_id, "model": model_name,
           "params": params, "n_train": len(X), **train_metrics}
print(summary)
dbutils.jobs.taskValues.set("mlflow_run_id", run.info.run_id)
dbutils.notebook.exit(json.dumps(summary))
