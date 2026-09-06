/**
 * Deep Meta ads audit — public exports.
 */
const { buildAdsAudit } = require("./build");
const { renderAdsAuditHtml } = require("./html");
const { diagnoseAd, diagnoseAds, DIAGNOSES } = require("./diagnose");
const { buildFunnel, explainFunnel } = require("./funnel");
const { enrichAuditInsightRow, extractVideoMetrics } = require("./enrich");
const { summarizeTargeting } = require("./targeting");
const {
  normalizeCreative,
  buildCreativeEvidence,
  groupByCreative,
} = require("./creative");
const {
  compareIndependentSnapshots,
  attachAdPeriodCompare,
  buildPeriodRanges,
} = require("./compare");

module.exports = {
  buildAdsAudit,
  renderAdsAuditHtml,
  diagnoseAd,
  diagnoseAds,
  DIAGNOSES,
  buildFunnel,
  explainFunnel,
  enrichAuditInsightRow,
  extractVideoMetrics,
  summarizeTargeting,
  normalizeCreative,
  buildCreativeEvidence,
  groupByCreative,
  compareIndependentSnapshots,
  attachAdPeriodCompare,
  buildPeriodRanges,
};
