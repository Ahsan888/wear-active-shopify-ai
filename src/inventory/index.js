/**
 * Public inventory intelligence API.
 */
const { resolveThresholds, DEFAULT_THRESHOLDS } = require("./thresholds");
const { fetchShopifyInventory } = require("./fetchInventory");
const { buildDemandWindows, demandForSku } = require("./demand");
const { buildInventoryReport } = require("./build");
const { printInventoryReport } = require("./report");
const classify = require("./classify");

module.exports = {
  resolveThresholds,
  DEFAULT_THRESHOLDS,
  fetchShopifyInventory,
  buildDemandWindows,
  demandForSku,
  buildInventoryReport,
  printInventoryReport,
  ...classify,
};
