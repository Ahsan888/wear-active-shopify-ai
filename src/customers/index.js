/**
 * Phase 6 — Customer & Cohort Economics (advisory).
 */
const { resolveCustomerIdentity, hashEmail, isIdentifiedCustomer } = require("./identity");
const {
  buildRecognizedCustomerOrders,
  assignOrderSequences,
} = require("./orders");
const { buildCustomerEconomics } = require("./build");
const { printCustomerReport } = require("./report");
const { buildObservedCac } = require("./cac");

module.exports = {
  resolveCustomerIdentity,
  hashEmail,
  isIdentifiedCustomer,
  buildRecognizedCustomerOrders,
  assignOrderSequences,
  buildCustomerEconomics,
  printCustomerReport,
  buildObservedCac,
};
