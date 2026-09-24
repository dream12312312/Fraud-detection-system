-- Run once in Databricks SQL editor (Free Edition)
CREATE CATALOG IF NOT EXISTS fraud;
CREATE SCHEMA IF NOT EXISTS fraud.analytics;
CREATE SCHEMA IF NOT EXISTS fraud.landing;
CREATE VOLUME IF NOT EXISTS fraud.landing.events;
