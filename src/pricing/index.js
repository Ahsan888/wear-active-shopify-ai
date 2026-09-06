/**
 * Phase 8 — Pricing & Promotion Intelligence (advisory).
 */
const { resolvePricingThresholds, DEFAULT_THRESHOLDS } = require("./thresholds");
const { fetchVariantPrices } = require("./fetchPrices");
const {
  unitEconomics,
  simulateDiscount,
  simulateIncrease,
  minimumMarginPrice,
  maximumSafeDiscountPct,
  buildSimulationLadder,
} = require("./simulate");
const { classifyPricingAction } = require("./classify");
const { buildPricingReport } = require("./build");
const { printPricingReport } = require("./report");

module.exports = {
  resolvePricingThresholds,
  DEFAULT_THRESHOLDS,
  fetchVariantPrices,
  unitEconomics,
  simulateDiscount,
  simulateIncrease,
  minimumMarginPrice,
  maximumSafeDiscountPct,
  buildSimulationLadder,
  classifyPricingAction,
  buildPricingReport,
  printPricingReport,
};
