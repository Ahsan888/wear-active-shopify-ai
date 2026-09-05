#!/usr/bin/env node
/**
 * Backfill daily snapshots (no delivery by default).
 *
 *   npm run reports:backfill -- --since=2026-08-15 --until=2026-09-05 --days=7
 */
const { hintForMetaError } = require("../meta/cli");
const { parseBackfillArgs, runBackfill } = require("../operations/backfill");

async function main() {
  const args = parseBackfillArgs(process.argv.slice(2));
  console.log(
    `Backfill ${args.since} → ${args.until} (trailing ${args.days || "default"}d)`
  );
  const result = await runBackfill(args);
  console.log(`Created/updated: ${result.created}`);
  console.log(`Failed: ${result.failed.length}`);
  if (result.failed.length) {
    for (const f of result.failed) {
      console.error(`  ${f.reporting_date}: ${f.error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
