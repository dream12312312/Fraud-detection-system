import { config } from './config.js';

const TIMEOUT_MS = 2000;

/**
 * Ask the Fraud Scoring Engine to evaluate a transaction.
 * Returns a normalized decision or null when the engine is unavailable,
 * in which case the caller must use the fallback rule engine.
 */
export async function scoreTransaction(payload) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${config.fraudEngineUrl}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.fraud_probability !== 'number') return null;
    // Normalize the engine's source label to the enum used by the Transaction
    // schema. The engine reports HEURISTIC when no trained model is loaded and
    // ML_MODEL otherwise; anything unexpected is treated as heuristic so a
    // schema mismatch can never fail a payment again.
    const KNOWN_SOURCES = ['ML_MODEL', 'HEURISTIC'];
    const source = KNOWN_SOURCES.includes(data.source) ? data.source : 'HEURISTIC';
    return {
      fraudProbability: data.fraud_probability,
      riskLevel: data.risk_level || 'LOW',
      decision: data.decision || 'APPROVE',
      reasons: Array.isArray(data.reasons) ? data.reasons : [],
      modelVersion: data.model_version || 'unknown',
      source
    };
  } catch {
    return null;
  }
}

/**
 * Deterministic fallback rules used when the ML engine is down.
 * Never approves high-value or unusual transactions silently.
 */
export function fallbackRules({ amount, dailyLimit = 10000, isNewBeneficiary = false, homeCountry = 'US', country = 'US' }) {
  const reasons = [];
  let decision = 'APPROVE';
  let riskLevel = 'LOW';
  let probability = 0.05;

  if (amount > dailyLimit) {
    reasons.push('AMOUNT_OVER_DAILY_LIMIT');
    decision = 'BLOCK'; riskLevel = 'HIGH'; probability = 0.95;
  } else if (isNewBeneficiary && amount > 5000) {
    reasons.push('NEW_BENEFICIARY_LARGE_AMOUNT');
    decision = 'REVIEW'; riskLevel = 'MEDIUM'; probability = 0.55;
  } else if (country !== homeCountry && amount > 2000) {
    reasons.push('FOREIGN_COUNTRY_LARGE_AMOUNT');
    decision = 'REVIEW'; riskLevel = 'MEDIUM'; probability = 0.5;
  } else if (amount > 8000) {
    reasons.push('HIGH_VALUE_TRANSACTION');
    decision = 'REVIEW'; riskLevel = 'MEDIUM'; probability = 0.4;
  }

  return { fraudProbability: probability, riskLevel, decision, reasons, modelVersion: 'fallback-rules-v1', source: 'RULES_FALLBACK' };
}
