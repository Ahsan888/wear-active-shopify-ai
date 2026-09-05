/**
 * Period-specific operational artifact paths.
 * Example: 2026-09-06-7d.json
 */
const path = require("path");
const { reportsRoot } = require("./files");

function periodSuffix(days) {
  return `${Number(days)}d`;
}

function datedPeriodBase(reportingDate, days) {
  return `${reportingDate}-${periodSuffix(days)}`;
}

function snapshotDatedPath(reportingDate, days, cwd = process.cwd()) {
  return path.join(
    reportsRoot(cwd),
    "snapshots",
    `${datedPeriodBase(reportingDate, days)}.json`
  );
}

function briefDatedPaths(reportingDate, days, cwd = process.cwd()) {
  const base = path.join(
    reportsRoot(cwd),
    "briefs",
    datedPeriodBase(reportingDate, days)
  );
  return { txt: `${base}.txt`, json: `${base}.json` };
}

function alertsDatedPath(reportingDate, days, cwd = process.cwd()) {
  return path.join(
    reportsRoot(cwd),
    "alerts",
    `${datedPeriodBase(reportingDate, days)}.json`
  );
}

function deliveryAuditPath(reportingDate, days, cwd = process.cwd()) {
  return path.join(
    reportsRoot(cwd),
    "delivery",
    `${datedPeriodBase(reportingDate, days)}.json`
  );
}

module.exports = {
  periodSuffix,
  datedPeriodBase,
  snapshotDatedPath,
  briefDatedPaths,
  alertsDatedPath,
  deliveryAuditPath,
};
