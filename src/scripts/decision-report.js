#!/usr/bin/env node
/**
 * Read-only decision intelligence report (Phase 3).
 *
 * Usage:
 *   npm run decisions:report -- --days=7
 *   npm run decisions:report -- --days=7 --json
 *
 * Advisory only — never writes Sheets, never mutates Meta.
 */
const {
  parseArgs,
  resolveDateRange,
  hintForMetaError,
} = require("../meta/cli");
const { loadDecisionInputs, TIMEZONE } = require("../decisions/loadInputs");
const {
  buildDecisionReport,
  printDecisionReport,
} = require("../decisions/report");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dateRange = resolveDateRange(args, TIMEZONE);
  const inputs = await loadDecisionInputs(dateRange.since, dateRange.until);
  const report = buildDecisionReport(inputs);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printDecisionReport(report);
  }
}

main().catch((err) => {
  console.error("Decision report failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
