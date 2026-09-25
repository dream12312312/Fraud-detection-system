-- Run once in Databricks SQL editor (Free Edition).
-- The admin console's "Databricks → Set up / sync workspace" button does the same
-- through the Unity Catalog REST API, so running this by hand is optional.
CREATE CATALOG IF NOT EXISTS fraud;
CREATE SCHEMA IF NOT EXISTS fraud.analytics;
CREATE SCHEMA IF NOT EXISTS fraud.landing;
CREATE VOLUME IF NOT EXISTS fraud.landing.events;
