/**
 * Phase 9 — Marketing Decision Engine (advisory orchestration).
 */
const { MARKETING } = require("./thresholds");
const { assessMarketingEvidence, entityEvidenceConfidence } = require("./evidence");
const {
  derivePerformanceDirection,
  deriveTrailingWindowConsistency,
  deriveIndependentPeriodEvidence,
  buildIndependentWindowRanges,
  hasIndependentRepeatedWeakness,
  hasIndependentRepeatedStrength,
  attachPeriodConsistency,
  indexEntitiesById,
} = require("./periods");
const { classifyMarketingEntity, classifyMarketingEntities } = require("./classify");
const { classifyAccountMarketingDecision } = require("./account");
const {
  buildOwnerActionQueue,
  buildPromotionOpportunities,
  priorityScore,
} = require("./queue");
const {
  loadEntityProductMap,
  indexEntityProductMap,
  lookupEntityProduct,
} = require("./mapping");
const { resolveInventoryMarketingContext } = require("./inventoryContext");
const {
  buildMarketingDecisionReport,
  formatMarketingBriefActions,
  buildMarketingFromUnifiedBundle,
} = require("./build");
const { printMarketingDecisionReport } = require("./report");

module.exports = {
  MARKETING,
  assessMarketingEvidence,
  entityEvidenceConfidence,
  derivePerformanceDirection,
  deriveTrailingWindowConsistency,
  deriveIndependentPeriodEvidence,
  buildIndependentWindowRanges,
  hasIndependentRepeatedWeakness,
  hasIndependentRepeatedStrength,
  attachPeriodConsistency,
  indexEntitiesById,
  classifyMarketingEntity,
  classifyMarketingEntities,
  classifyAccountMarketingDecision,
  buildOwnerActionQueue,
  buildPromotionOpportunities,
  priorityScore,
  loadEntityProductMap,
  indexEntityProductMap,
  lookupEntityProduct,
  resolveInventoryMarketingContext,
  buildMarketingDecisionReport,
  formatMarketingBriefActions,
  buildMarketingFromUnifiedBundle,
  printMarketingDecisionReport,
};
