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
  minimumAccountingSafeStickerPrice,
  accountingSafeFloorPrice,
  maximumSafeDiscountPct,
  buildSimulationLadder,
} = require("./simulate");
const { classifyPricingAction } = require("./classify");
const { buildPricingReport } = require("./build");
const { printPricingReport } = require("./report");
const { resolveClearanceMaturity } = require("./maturity");

module.exports = {
  resolvePricingThresholds,
  DEFAULT_THRESHOLDS,
  fetchVariantPrices,
  unitEconomics,
  simulateDiscount,
  simulateIncrease,
  minimumMarginPrice,
  minimumAccountingSafeStickerPrice,
  accountingSafeFloorPrice,
  maximumSafeDiscountPct,
  buildSimulationLadder,
  classifyPricingAction,
  buildPricingReport,
  printPricingReport,
  resolveClearanceMaturity,
};
